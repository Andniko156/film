import copy
import json
import re
import time
from datetime import timedelta
from unittest.mock import Mock, patch
from django.conf import settings
from django.core import mail
from django.test import Client, TestCase, override_settings
from django.utils import timezone
from .models import Archive, EmailChallenge, Identity, Movie, RateBucket, User
from .security import create_user


def fixture():
    return {'version':2,'revision':0,'movies':[{'id':'movie_one','title':'Личный фильм','type':'FILM','year':'2026','genre':'драма','poster':'','createdAt':'2026-10-27T12:00:00Z','tags':['уютное'],'planned':False}],
        'views':[{'id':'view_one','movieId':'movie_one','date':'2026-10-27','rating':5,'note':'Личная заметка','company':'','mood':'','createdAt':''}],
        'quotes':[{'id':'quote_one','movieId':'movie_one','text':'<img src=x onerror=alert(1)>','character':'','time':'12:30','note':'','tags':[],'spoiler':True,'createdAt':''}],
        'collections':[{'id':'collection_one','name':'Любимое','description':'','movieIds':['movie_one']}], 'presets':[]}


class SecurityTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.state = self.client.get('/api/session').json()

    def send(self, url, value, client=None, state=None, method='post'):
        client=client or self.client; state=state or self.state
        return getattr(client,method)(url,data=json.dumps(value),content_type='application/json',HTTP_X_CSRFTOKEN=state['csrf'],HTTP_X_FILM_ACCOUNT=(state.get('user') or {}).get('id',''))

    def start(self,email='a@example.com',link=False):
        return self.send('/api/auth/email/start',{'email':email,'link':link})

    def code(self):
        return re.search(r'\b\d{8}\b',mail.outbox[-1].body)[0]

    def login(self,email='a@example.com'):
        self.assertEqual(self.start(email).status_code,200)
        response=self.send('/api/auth/email/verify',{'email':email,'code':self.code()})
        self.assertEqual(response.status_code,200)
        self.state=response.json()
        return User.objects.get(username=self.state['user']['id'])

    def get_archive(self):
        return self.client.get('/api/archive',HTTP_X_FILM_ACCOUNT=self.state['user']['id'])

    def save(self,data=None,rev=0,method='put'):
        return self.send('/api/archive',{'archive':data or fixture(),'expectedRevision':rev},method=method)

    def test_password_remember_me_sets_expiring_cookie(self):
        self.login()
        response=self.send('/api/auth/password/set',{'password':'Strong unusual example passphrase 86420'})
        self.state=response.json()
        self.send('/api/auth/logout',{})
        self.state=self.client.get('/api/session').json()
        response=self.send('/api/auth/password/login',{'email':'a@example.com','password':'Strong unusual example passphrase 86420','remember':True})
        self.assertEqual(response.status_code,200)
        self.assertTrue(self.client.session['remember_login'])
        self.assertFalse(self.client.session.get_expire_at_browser_close())
        self.assertGreater(self.client.session.get_expiry_age(), 20*24*3600)

    def test_password_login_without_remember_expires_with_browser(self):
        self.login()
        response=self.send('/api/auth/password/set',{'password':'Strong unusual example passphrase 86420'})
        self.state=response.json()
        self.send('/api/auth/logout',{})
        self.state=self.client.get('/api/session').json()
        response=self.send('/api/auth/password/login',{'email':'a@example.com','password':'Strong unusual example passphrase 86420','remember':False})
        self.assertEqual(response.status_code,200)
        self.assertFalse(self.client.session['remember_login'])
        self.assertTrue(self.client.session.get_expire_at_browser_close())

    def test_password_login_reuses_email_identity(self):
        user = self.login()
        user_id = user.username
        response=self.send('/api/auth/password/set',{'password':'Strong unusual example passphrase 86420'})
        self.assertEqual(response.status_code,200)
        self.state=response.json()
        self.send('/api/auth/logout',{})
        self.state=self.client.get('/api/session').json()
        self.assertEqual(self.send('/api/auth/password/login',{'email':'a@example.com','password':'wrong'}).status_code,401)
        response=self.send('/api/auth/password/login',{'email':'a@example.com','password':'Strong unusual example passphrase 86420'})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['user']['id'],user_id)

    def test_password_set_requires_linked_email(self):
        user=self.login()
        Identity.objects.filter(user=user,provider='email').delete()
        self.assertEqual(self.send('/api/auth/password/set',{'password':'Strong unusual example passphrase 86420'}).status_code,403)

    def test_password_throttle_is_separate_from_email_code(self):
        self.login()
        response=self.send('/api/auth/password/set',{'password':'Strong unusual example passphrase 86420'})
        self.assertEqual(response.status_code,200)
        self.state=response.json()
        self.send('/api/auth/logout',{})
        self.state=self.client.get('/api/session').json()
        for _ in range(8):
            self.send('/api/auth/password/login',{'email':'a@example.com','password':'wrong'})
        self.assertEqual(self.send('/api/auth/password/login',{'email':'a@example.com','password':'Strong unusual example passphrase 86420'}).status_code,429)
        self.assertEqual(self.send('/api/auth/email/start',{'email':'a@example.com','link':False}).status_code,200)

    def test_registration_requires_email_code_before_account_creation(self):
        start=self.start('new@example.com')
        self.assertEqual(start.status_code,200)
        self.assertFalse(Identity.objects.filter(provider='email',subject='new@example.com').exists())
        self.assertEqual(self.send('/api/auth/register/verify',{'email':'new@example.com','code':'00000000','password':'Long unique passphrase 98766'}).status_code,400)
        result=self.send('/api/auth/register/verify',{'email':'new@example.com','code':self.code(),'password':'Long unique passphrase 98766'})
        self.assertEqual(result.status_code,200)
        self.assertIn('email',result.json()['user']['providers'])
        user=Identity.objects.get(provider='email',subject='new@example.com').user
        self.assertTrue(user.check_password('Long unique passphrase 98766'))
        self.send('/api/auth/logout',{})
        self.state=self.client.get('/api/session').json()
        self.assertEqual(self.send('/api/auth/register/verify',{'email':'new@example.com','code':self.code(),'password':'Long unique passphrase 98766'}).status_code,409)

    def test_registration_does_not_take_over_existing_email(self):
        self.login()
        self.send('/api/auth/logout',{})
        self.state=self.client.get('/api/session').json()
        self.assertEqual(self.start('a@example.com').status_code,200)
        result=self.send('/api/auth/register/verify',{'email':'a@example.com','code':self.code(),'password':'Long unique passphrase 98766'})
        self.assertEqual(result.status_code,409)
        self.assertEqual(Identity.objects.filter(provider='email',subject='a@example.com').count(),1)

    def test_csrf_required_for_email_and_archive(self):
        self.assertEqual(self.client.post('/api/auth/email/start',data='{}',content_type='application/json').status_code,403)
        self.login()
        self.assertEqual(self.client.put('/api/archive',data='{}',content_type='application/json').status_code,403)

    def test_code_hmac_single_use_and_no_password(self):
        self.start(); code=self.code(); challenge=EmailChallenge.objects.get()
        self.assertNotEqual(challenge.digest,code); self.assertNotIn(code,challenge.digest)
        self.state=self.send('/api/auth/email/verify',{'email':'a@example.com','code':code}).json()
        self.assertFalse(User.objects.get().has_usable_password())
        self.send('/api/auth/logout',{}); self.state=self.client.get('/api/session').json()
        self.assertEqual(self.send('/api/auth/email/verify',{'email':'a@example.com','code':code}).status_code,400)

    def test_expired_code_rejected(self):
        self.start(); code=self.code(); EmailChallenge.objects.update(expires_at=timezone.now()-timedelta(seconds=1))
        self.assertEqual(self.send('/api/auth/email/verify',{'email':'a@example.com','code':code}).status_code,400)
        self.assertEqual(User.objects.count(),0)

    def test_attempt_limit_and_resend_invalidation(self):
        self.start(); old=self.code(); self.start(); new=self.code()
        self.assertEqual(self.send('/api/auth/email/verify',{'email':'a@example.com','code':old}).status_code,400)
        for _ in range(4): self.send('/api/auth/email/verify',{'email':'a@example.com','code':'00000000' if new!='00000000' else '11111111'})
        self.assertEqual(self.send('/api/auth/email/verify',{'email':'a@example.com','code':new}).status_code,400)

    def test_send_rate_limit(self):
        for _ in range(5): self.assertEqual(self.start().status_code,200)
        self.assertEqual(self.start().status_code,429)
        self.assertFalse(RateBucket.objects.filter(key__contains='example').exists())

    def test_existing_and_new_email_same_response(self):
        first=self.start().json(); self.login()
        self.send('/api/auth/logout',{}); self.state=self.client.get('/api/session').json()
        self.assertEqual(self.start().json(),first)
        self.assertEqual(self.start('new@example.com').json(),first)

    @patch('cinema.views.send_mail',side_effect=RuntimeError('SMTP body must not be logged'))
    def test_failed_delivery_invalidates_code(self,send):
        self.assertEqual(self.start().status_code,503)
        self.assertTrue(EmailChallenge.objects.get().consumed)

    def test_anonymous_cannot_read_or_write(self):
        self.assertEqual(self.client.get('/api/archive').status_code,401)
        self.assertEqual(self.save().status_code,401)
        self.assertEqual(self.client.get('/api/catalog?q=abc').status_code,401)

    def test_two_users_isolated_and_header_cannot_change_owner(self):
        alice=self.login(); self.assertEqual(self.save().status_code,200)
        alice_state=self.state; alice_client=self.client
        self.client=Client(enforce_csrf_checks=True); self.state=self.client.get('/api/session').json(); bob=self.login('b@example.com')
        self.assertEqual(self.get_archive().json()['movies'],[])
        bad=self.client.get('/api/archive',HTTP_X_FILM_ACCOUNT=alice.username)
        self.assertEqual(bad.status_code,409)
        data=fixture();data['movies'][0]['title']='Bob';self.assertEqual(self.save(data).status_code,200)
        self.assertEqual(Movie.objects.get(archive__user=alice).data['title'],'Личный фильм')
        self.assertEqual(Movie.objects.get(archive__user=bob).data['title'],'Bob')
        self.assertEqual(alice_client.get('/api/archive',HTTP_X_FILM_ACCOUNT=alice_state['user']['id']).json()['movies'][0]['title'],'Личный фильм')

    def test_roundtrip_preserves_plain_text(self):
        self.login(); self.save(); result=self.get_archive().json(); expected=fixture();expected['revision']=1
        self.assertEqual(result,expected)

    def test_unknown_owner_and_broken_references_rejected_atomically(self):
        self.login(); self.save()
        for mutate in [lambda x:x['movies'][0].update(ownerId=42),lambda x:x['quotes'][0].update(movieId='other'),lambda x:x['collections'][0].update(movieIds=['foreign']),lambda x:x['views'][0].update(rating=True),lambda x:x['movies'][0].update(poster='javascript:alert(1)'),lambda x:x['movies'][0].update(title='x'*301)]:
            data=fixture();mutate(data)
            self.assertEqual(self.save(data,1).status_code,400)
            self.assertEqual(self.get_archive().json()['revision'],1)

    def test_stale_write_does_not_overwrite(self):
        self.login();self.save();data=fixture();data['movies'][0]['title']='Lost update'
        self.assertEqual(self.save(data,0).status_code,409)
        self.assertEqual(self.get_archive().json()['movies'][0]['title'],'Личный фильм')

    def test_import_idempotent_even_after_later_edit(self):
        self.login();self.assertEqual(self.save(method='post').status_code,200)
        data=fixture();data['movies'][0]['title']='Later';self.assertEqual(self.save(data,1).status_code,200)
        self.assertTrue(self.save(method='post').json()['alreadyImported'])
        self.assertEqual(self.get_archive().json()['movies'][0]['title'],'Later')

    def test_guest_transfer_cannot_replace_nonempty_account(self):
        self.login();self.save();self.assertEqual(self.save(rev=1,method='post').status_code,409)

    def test_duplicate_json_fields_rejected(self):
        self.assertEqual(self.client.post('/api/auth/email/start',data='{"email":"a@example.com","email":"b@example.com"}',content_type='application/json',HTTP_X_CSRFTOKEN=self.state['csrf']).status_code,400)

    def test_linking_requires_same_session_and_does_not_merge(self):
        alice=self.login(); self.start('linked@example.com',True); code=self.code()
        stranger=Client(enforce_csrf_checks=True); other=stranger.get('/api/session').json()
        self.assertEqual(self.send('/api/auth/email/verify',{'email':'linked@example.com','code':code},stranger,other).status_code,403)
        self.assertEqual(Identity.objects.filter(user=alice).count(),1)
        # Existing email provider cannot be silently replaced.
        self.assertEqual(self.send('/api/auth/email/verify',{'email':'linked@example.com','code':code}).status_code,409)

    @override_settings(YANDEX_CLIENT_ID='test-client',YANDEX_CLIENT_SECRET='test-secret')
    def test_new_identity_requires_recent_confirmation(self):
        self.login();session=self.client.session;session['recent_auth']=int(time.time())-601;session.save()
        self.assertEqual(self.start('new@example.com',True).status_code,403)
        self.assertEqual(self.send('/api/auth/yandex/start',{'link':True}).status_code,403)
        # Reconfirming the existing method is allowed to refresh the assurance time.
        self.assertEqual(self.start('a@example.com',True).status_code,200)
        response=self.send('/api/auth/email/verify',{'email':'a@example.com','code':self.code()})
        self.assertEqual(response.status_code,200);self.state=response.json()
        self.assertEqual(self.send('/api/auth/yandex/start',{'link':True}).status_code,200)

    def test_logout_all_revokes_other_device(self):
        user=self.login(); other=Client(enforce_csrf_checks=True)
        other.cookies=self.client.cookies.copy()
        self.assertEqual(self.send('/api/auth/logout-all',{}).status_code,200)
        self.assertIsNone(other.get('/api/session').json()['user'])
        user.refresh_from_db();self.assertEqual(user.session_version,1)

    def test_idle_and_absolute_expiration(self):
        self.login(); session=self.client.session;session['last_seen']=int(time.time())-settings.SESSION_IDLE_SECONDS-1;session.save()
        self.assertIsNone(self.client.get('/api/session').json()['user'])
        self.state=self.client.get('/api/session').json();self.login()
        session=self.client.session;session['auth_at']=int(time.time())-settings.SESSION_ABSOLUTE_SECONDS-1;session.save()
        self.assertIsNone(self.client.get('/api/session').json()['user'])

    def test_delete_requires_recent_login_and_cascades(self):
        self.login();self.save();session=self.client.session;session['recent_auth']=int(time.time())-601;session.save()
        self.assertEqual(self.send('/api/account/delete',{'confirm':'DELETE'}).status_code,403)
        session=self.client.session;session['recent_auth']=int(time.time());session.save()
        self.assertEqual(self.send('/api/account/delete',{'confirm':'DELETE'}).status_code,200)
        self.assertEqual(Movie.objects.count(),0);self.assertEqual(User.objects.count(),0)

    def test_security_headers_and_static_allowlist(self):
        response=self.client.get('/')
        self.assertIn("script-src 'self'",response['Content-Security-Policy'])
        self.assertEqual(response['Referrer-Policy'],'no-referrer')
        self.assertEqual(response['X-Frame-Options'],'DENY')
        self.assertIn('no-store',self.client.get('/api/session')['Cache-Control'])
        for path in ['/server/settings.py','/.env','/README.md','/admin/']:
            self.assertEqual(self.client.get(path).status_code,404)
        self.login();cookie=self.client.cookies[settings.SESSION_COOKIE_NAME]
        self.assertTrue(cookie['httponly']);self.assertEqual(cookie['samesite'],'Lax')

    @override_settings(YANDEX_CLIENT_ID='test-client',YANDEX_CLIENT_SECRET='test-secret')
    def test_oauth_state_pkce_replay_and_subject_not_email(self):
        response=self.send('/api/auth/yandex/start',{'link':False});self.assertEqual(response.status_code,200)
        self.assertIn('code_challenge_method=S256',response.json()['url'])
        flow=self.client.session['oauth']
        self.assertEqual(self.client.get('/api/auth/yandex/callback?state=wrong&code=abc')['Location'],'/#account-error')
        self.assertNotIn('oauth',self.client.session)
        self.send('/api/auth/yandex/start',{'link':False});flow=self.client.session['oauth']
        token=Mock();token.json.return_value={'access_token':'provider-token'}
        profile=Mock();profile.json.return_value={'id':'yandex-subject','client_id':'test-client','default_email':'a@example.com'}
        with patch('cinema.views.requests.post',return_value=token) as post,patch('cinema.views.requests.get',return_value=profile):
            response=self.client.get('/api/auth/yandex/callback',{'state':flow['state'],'code':'code'})
            self.assertEqual(response['Location'],'/#home')
            self.assertEqual(post.call_args.kwargs['data']['code_verifier'],flow['verifier'])
        self.assertEqual(Identity.objects.get().subject,'yandex-subject')
        self.assertNotIn('provider-token',str(dict(self.client.session)))
        self.assertEqual(self.client.get('/api/auth/yandex/callback',{'state':flow['state'],'code':'code'})['Location'],'/#account-error')

    @override_settings(YANDEX_CLIENT_ID='test-client',YANDEX_CLIENT_SECRET='test-secret')
    def test_oauth_email_does_not_merge_existing_account(self):
        alice=self.login();self.send('/api/auth/logout',{});self.state=self.client.get('/api/session').json()
        self.send('/api/auth/yandex/start',{'link':False});flow=self.client.session['oauth']
        token=Mock();token.json.return_value={'access_token':'token'}
        profile=Mock();profile.json.return_value={'id':'yandex-subject','client_id':'test-client','default_email':'a@example.com'}
        with patch('cinema.views.requests.post',return_value=token),patch('cinema.views.requests.get',return_value=profile):
            self.client.get('/api/auth/yandex/callback',{'state':flow['state'],'code':'code'})
        self.assertEqual(User.objects.count(),2)
        self.assertNotEqual(Identity.objects.get(provider='yandex').user_id,alice.pk)

    @override_settings(YANDEX_CLIENT_ID='test-client',YANDEX_CLIENT_SECRET='test-secret')
    def test_oauth_wrong_client_rejected(self):
        self.send('/api/auth/yandex/start',{'link':False});flow=self.client.session['oauth']
        token=Mock();token.json.return_value={'access_token':'token'}
        profile=Mock();profile.json.return_value={'id':'subject','client_id':'wrong'}
        with patch('cinema.views.requests.post',return_value=token),patch('cinema.views.requests.get',return_value=profile):
            self.assertEqual(self.client.get('/api/auth/yandex/callback',{'state':flow['state'],'code':'code'})['Location'],'/#account-error')
        self.assertEqual(User.objects.count(),0)

    @override_settings(KINOPOISK_API_KEY='server-test-secret')
    def test_catalog_proxy_does_not_expose_key_and_uses_fixed_url(self):
        self.login()
        response=Mock(); response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        response.iter_content.return_value=[json.dumps({'items':[{'nameRu':'Movie','secret':'not-forwarded'}]}).encode()]
        with patch('cinema.views.requests.get',return_value=response) as get:
            result=self.client.get('/api/catalog',{'q':'https://127.0.0.1/secrets'},HTTP_X_FILM_ACCOUNT=self.state['user']['id'])
            self.assertEqual(result.status_code,200)
            self.assertEqual(get.call_args.args[0],'https://kinopoiskapiunofficial.tech/api/v2.2/films')
            self.assertNotIn('server-test-secret',result.content.decode());self.assertNotIn('not-forwarded',result.content.decode())

# Locks and optimistic concurrency must also be exercised against PostgreSQL in CI.
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from django.db import connection, connections, transaction
from django.test import TransactionTestCase
from unittest import skipUnless
from . import archive as archive_store
from .validation import validate


@skipUnless(connection.vendor == 'postgresql', 'Requires real PostgreSQL row locks; CI runs this suite with PostgreSQL')
class PostgreSQLConcurrencyTests(TransactionTestCase):
    def test_two_simultaneous_revisions_only_one_commits(self):
        user=create_user();barrier=Barrier(2)
        def write(title):
            try:
                barrier.wait(timeout=10)
                with transaction.atomic():
                    archive=Archive.objects.select_for_update().get(user_id=user.pk)
                    if archive.revision!=0:return 'conflict'
                    data=fixture();data['movies'][0]['title']=title
                    archive_store.replace(archive,validate(data))
                    return 'saved'
            finally: connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(write,title) for title in ['First','Second']]
            self.assertEqual(sorted(f.result(timeout=15) for f in futures),['conflict','saved'])
        self.assertEqual(Archive.objects.get(user=user).revision,1)
        self.assertEqual(Movie.objects.filter(archive__user=user).count(),1)

    def test_failed_multi_table_replacement_rolls_back(self):
        user=create_user()
        with transaction.atomic():
            archive=Archive.objects.select_for_update().get(user=user)
            archive_store.replace(archive,fixture())
        try:
            with transaction.atomic():
                archive=Archive.objects.select_for_update().get(user=user)
                archive.movies.all().delete()
                raise RuntimeError('Interrupted import')
        except RuntimeError:pass
        archive.refresh_from_db()
        self.assertEqual(archive.revision,1)
        self.assertEqual(archive_store.read(archive)['quotes'],fixture()['quotes'])

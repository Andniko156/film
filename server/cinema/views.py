import base64
import hashlib
import hmac
import json
import secrets
import time
from datetime import timedelta
from urllib.parse import urlencode
import requests
from django.conf import settings
from django.contrib.auth import logout
from django.core.exceptions import RequestDataTooBig, ValidationError
from django.core.mail import send_mail
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.db.models import F
from django.http import FileResponse, HttpResponseRedirect, JsonResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST, require_http_methods
from . import archive as archive_store
from .models import Archive, EmailChallenge, Identity, ImportReceipt, User
from .security import allow, audit, authenticated, create_user, digest, establish, ip
from .validation import validate


def error(message, status=400):
    return JsonResponse({'error': message}, status=status)


def csrf_failure(request, reason=''):
    return error('Проверка безопасности не пройдена. Обновите страницу.', 403)


def body(request):
    if request.content_type != 'application/json':
        raise ValueError('Ожидается JSON.')
    def pairs(items):
        result = {}
        for k,v in items:
            if k in result: raise ValueError('Повторяющееся поле JSON.')
            result[k] = v
        return result
    try:
        value = json.loads(request.body, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Недопустимое число.')))
    except (json.JSONDecodeError, UnicodeDecodeError, RequestDataTooBig, RecursionError):
        raise ValueError('Некорректный или слишком большой JSON.')
    if not isinstance(value, dict): raise ValueError('Ожидается объект JSON.')
    return value


def email_value(value):
    if not isinstance(value, str) or len(value) > 254: raise ValueError('Проверьте email.')
    value = value.strip().lower()
    try: validate_email(value)
    except ValidationError: raise ValueError('Проверьте email.')
    return value


def snapshot(request):
    user = None
    if request.user.is_authenticated:
        identities = request.user.identities.all()
        email = next((i.subject for i in identities if i.provider == 'email'), '')
        user = {'id': request.user.username, 'email': email, 'providers': [i.provider for i in identities]}
    return {'user': user, 'csrf': get_token(request), 'emailEnabled': settings.MAIL_ENABLED,
            'yandexEnabled': bool(settings.YANDEX_CLIENT_ID and settings.YANDEX_CLIENT_SECRET),
            'catalogEnabled': bool(settings.KINOPOISK_API_KEY)}


@require_GET
def session(request):
    return JsonResponse(snapshot(request))


@require_POST
def email_start(request):
    if not settings.MAIL_ENABLED: return error('Вход по почте пока не настроен.', 503)
    try:
        data = body(request)
        if set(data) - {'email','link'}: raise ValueError('Неизвестные поля.')
        email = email_value(data.get('email'))
        linking = data.get('link', False)
        if type(linking) is not bool: raise ValueError('Некорректная операция.')
    except ValueError as e: return error(str(e))
    if request.user.is_authenticated != linking:
        return error('Для привязки почты войдите в аккаунт; для обычного входа выйдите из него.', 409)
    if linking and request.headers.get('X-Film-Account') != request.user.username:
        return error('Аккаунт изменился.', 409)
    if linking and not Identity.objects.filter(user=request.user, provider='email', subject=email).exists() and time.time()-request.session.get('recent_auth',0)>600:
        return error('Сначала повторно подтвердите вход существующим способом.',403)
    if not allow('email-send-ip', ip(request), 20, 3600) or not allow('email-send-address', email, 5, 3600):
        return error('Слишком много запросов. Попробуйте позже.', 429)
    code = ''.join(secrets.choice('0123456789') for _ in range(8))
    with transaction.atomic():
        EmailChallenge.objects.get_or_create(email=email, defaults={'digest':'', 'expires_at':timezone.now()})
        challenge = EmailChallenge.objects.select_for_update().get(email=email)
        challenge.nonce = secrets.token_hex(16)
        # UUID normalisation must be identical at verification.
        import uuid
        challenge.nonce = uuid.UUID(challenge.nonce)
        challenge.digest = digest('otp:' + email + ':' + str(challenge.nonce) + ':' + code)
        challenge.expires_at = timezone.now() + timedelta(minutes=10)
        challenge.attempts = 0
        challenge.consumed = False
        challenge.link_user = request.user if linking else None
        challenge.session_digest = digest(request.session.session_key or '') if linking else ''
        challenge.save()
        nonce = challenge.nonce
    try:
        send_mail('Код входа в CineDairy', f'Ваш код: {code}\nОн действует 10 минут. Никому его не сообщайте.\nЕсли вы не запрашивали код, проигнорируйте письмо.', settings.DEFAULT_FROM_EMAIL, [email], fail_silently=False)
    except Exception:
        # Do not log SMTP exceptions: some transports include addresses/body.
        EmailChallenge.objects.filter(email=email, nonce=nonce).update(consumed=True)
        audit('mail_delivery_failed')
        return error('Не удалось отправить письмо. Попробуйте позже.', 503)
    audit('email_challenge_created')
    return JsonResponse({'message':'Если адрес указан верно, письмо придёт в ближайшее время.'})


@require_POST
def email_verify(request):
    try:
        data = body(request)
        if set(data) != {'email','code'}: raise ValueError('Некорректный запрос.')
        email = email_value(data.get('email')); code = data.get('code')
        if not isinstance(code,str) or len(code)!=8 or not code.isascii() or not code.isdigit(): raise ValueError('Код недействителен или истёк.')
    except ValueError as e: return error(str(e))
    if not allow('email-verify-ip', ip(request), 30, 600) or not allow('email-verify-address', email, 10, 600):
        return error('Слишком много попыток. Попробуйте позже.', 429)
    try:
        with transaction.atomic():
            challenge = EmailChallenge.objects.select_for_update().filter(email=email).first()
            if not challenge or challenge.consumed or challenge.expires_at <= timezone.now() or challenge.attempts >= 5:
                return error('Код недействителен или истёк.')
            challenge.attempts += 1
            challenge.save(update_fields=['attempts'])
            expected = digest('otp:' + email + ':' + str(challenge.nonce) + ':' + code)
            if not hmac.compare_digest(expected, challenge.digest): return error('Код недействителен или истёк.')
            if challenge.link_user_id:
                if (not request.user.is_authenticated or request.user.pk != challenge.link_user_id or
                    request.headers.get('X-Film-Account') != request.user.username or
                    not hmac.compare_digest(challenge.session_digest, digest(request.session.session_key or ''))):
                    return error('Подтвердите привязку в той же сессии.', 403)
            elif request.user.is_authenticated:
                return error('Сначала выйдите из текущего аккаунта.', 409)
            challenge.consumed = True
            challenge.save(update_fields=['consumed'])
            identity = Identity.objects.select_related('user').filter(provider='email', subject=email).first()
            if challenge.link_user_id:
                user = User.objects.select_for_update().get(pk=request.user.pk)
                existing = Identity.objects.filter(user=user, provider='email').first()
                if (identity and identity.user_id != user.pk) or (existing and existing.subject != email):
                    return error('Этот способ входа уже связан с аккаунтом. Автоматическое объединение недоступно.',409)
            else:
                user = identity.user if identity else create_user()
            if not identity: Identity.objects.create(user=user, provider='email', subject=email)
            if not user.is_active: return error('Вход недоступен.',403)
            establish(request,user)
    except IntegrityError:
        return error('Не удалось завершить вход. Запросите новый код.',409)
    return JsonResponse(snapshot(request))


@authenticated(['POST'])
def sign_out(request):
    audit('logout',request.user); logout(request)
    return JsonResponse({'ok':True})


@authenticated(['POST'])
def sign_out_all(request):
    User.objects.filter(pk=request.user.pk).update(session_version=F('session_version')+1)
    audit('logout_all',request.user); logout(request)
    return JsonResponse({'ok':True})


@authenticated(['POST'])
def delete_account(request):
    if time.time()-request.session.get('recent_auth',0)>600:
        return error('Повторно подтвердите вход перед удалением.',403)
    try:
        if body(request) != {'confirm':'DELETE'}: return error('Подтвердите удаление.')
    except ValueError as e: return error(str(e))
    user = request.user
    with transaction.atomic():
        User.objects.select_for_update().get(pk=user.pk)
        audit('account_deleted',user); logout(request); user.delete()
    return JsonResponse({'ok':True})


@require_POST
def yandex_start(request):
    if not settings.YANDEX_CLIENT_ID or not settings.YANDEX_CLIENT_SECRET: return error('Вход через Яндекс пока не настроен.',503)
    try:
        data=body(request)
        if set(data)!={'link'} or type(data['link']) is not bool: raise ValueError('Некорректный запрос.')
    except ValueError as e: return error(str(e))
    if request.user.is_authenticated != data['link']: return error('Состояние аккаунта изменилось.',409)
    if data['link'] and request.headers.get('X-Film-Account') != request.user.username: return error('Состояние аккаунта изменилось.',409)
    if data['link'] and not request.user.identities.filter(provider='yandex').exists() and time.time()-request.session.get('recent_auth',0)>600:
        return error('Сначала повторно подтвердите вход существующим способом.',403)
    if not allow('oauth-start',ip(request),30,600): return error('Попробуйте позже.',429)
    state=secrets.token_urlsafe(32); verifier=secrets.token_urlsafe(48)
    request.session['oauth']={'state':state,'verifier':verifier,'at':int(time.time()),'link_user':request.user.pk if data['link'] else None}
    challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    url='https://oauth.yandex.ru/authorize?'+urlencode({'response_type':'code','client_id':settings.YANDEX_CLIENT_ID,
        'redirect_uri':settings.YANDEX_REDIRECT_URI,'state':state,'code_challenge':challenge,'code_challenge_method':'S256','scope':'login:info','force_confirm':'yes'})
    return JsonResponse({'url':url})


@require_GET
def yandex_callback(request):
    flow=request.session.pop('oauth',None)
    if not flow or time.time()-flow['at']>600 or not hmac.compare_digest(request.GET.get('state',''),flow['state']):
        return HttpResponseRedirect('/#account-error')
    if bool(flow['link_user']) != request.user.is_authenticated or (flow['link_user'] and flow['link_user']!=request.user.pk):
        return HttpResponseRedirect('/#account-error')
    code=request.GET.get('code','')
    if not code or len(code)>2048: return HttpResponseRedirect('/#account-error')
    try:
        response=requests.post('https://oauth.yandex.ru/token',data={'grant_type':'authorization_code','code':code,
            'client_id':settings.YANDEX_CLIENT_ID,'client_secret':settings.YANDEX_CLIENT_SECRET,
            'redirect_uri':settings.YANDEX_REDIRECT_URI,'code_verifier':flow['verifier']},timeout=8,allow_redirects=False)
        response.raise_for_status(); token=response.json()['access_token']
        response=requests.get('https://login.yandex.ru/info',headers={'Authorization':'OAuth '+token},params={'format':'json'},timeout=8,allow_redirects=False)
        response.raise_for_status(); profile=response.json()
        if not isinstance(profile,dict): raise ValueError()
        subject=profile.get('id')
        if not isinstance(subject,str) or not subject or len(subject)>254 or profile.get('client_id')!=settings.YANDEX_CLIENT_ID: raise ValueError()
        with transaction.atomic():
            identity=Identity.objects.select_related('user').filter(provider='yandex',subject=subject).first()
            if flow['link_user']:
                user=User.objects.select_for_update().get(pk=flow['link_user'])
                existing=Identity.objects.filter(user=user,provider='yandex').first()
                if identity and identity.user_id != user.pk:
                    audit('oauth_link_conflict', user)
                    return HttpResponseRedirect('/#account-link-conflict')
                if existing and existing.subject != subject:
                    audit('oauth_link_conflict', user)
                    return HttpResponseRedirect('/#account-link-conflict')
            else: user=identity.user if identity else create_user()
            if not user.is_active: raise ValueError()
            if not identity: Identity.objects.create(user=user,provider='yandex',subject=subject)
            establish(request,user)
        # Provider tokens are discarded; identity is matched by subject, never email.
    except (requests.RequestException, ValueError, KeyError, TypeError, IntegrityError, User.DoesNotExist):
        audit('oauth_failed'); return HttpResponseRedirect('/#account-error')
    return HttpResponseRedirect('/#home')


@authenticated(['GET','PUT','POST'])
def archive(request):
    if request.method=='GET':
        # Serialize reads and writes for a consistent multi-table snapshot.
        with transaction.atomic():
            saved=Archive.objects.select_for_update().get(user=request.user)
            return JsonResponse(archive_store.read(saved))
    try:
        data=body(request)
        if set(data) != {'archive','expectedRevision'}: raise ValueError('Неизвестные поля запроса.')
        candidate=validate(data['archive']); expected=data['expectedRevision']
        if type(expected) is not int or expected<0: raise ValueError('Укажите версию архива.')
    except (ValueError, TypeError) as e: return error(str(e) if isinstance(e,ValueError) else 'Некорректный архив.')
    if not allow('archive-write',str(request.user.pk),120,60): return error('Слишком частые изменения. Подождите минуту.',429)
    with transaction.atomic():
        saved=Archive.objects.select_for_update().get(user=request.user)
        importing=request.method=='POST'
        digest_value=archive_store.fingerprint(candidate)
        if importing and ImportReceipt.objects.filter(archive=saved,digest=digest_value).exists():
            return JsonResponse({'revision':saved.revision,'alreadyImported':True})
        if saved.revision!=expected:
            return JsonResponse({'error':'Архив изменён на другом устройстве. Скачайте несохранённую копию и загрузите актуальный архив.','conflict':True,'revision':saved.revision},status=409)
        # Guest transfer only into an empty account. Replacement of a nonempty archive uses PUT with explicit UI confirmation.
        if importing and (saved.movies.exists() or saved.collections.exists() or saved.presets.exists()):
            return error('В аккаунте уже есть записи. Сохраните обе копии и используйте явное восстановление архива.',409)
        archive_store.replace(saved,candidate)
        if importing: ImportReceipt.objects.create(archive=saved,digest=digest_value)
        audit('archive_imported' if importing else 'archive_saved',request.user)
        return JsonResponse({'revision':saved.revision})


@authenticated(['GET'])
def catalog(request):
    if not settings.KINOPOISK_API_KEY: return error('Автопоиск пока не настроен. Добавьте фильм вручную.',503)
    query=request.GET.get('q','').strip()
    if not 2<=len(query)<=150: return error('Введите от 2 до 150 символов.')
    if not allow('catalog',str(request.user.pk),30,60): return error('Слишком частый поиск.',429)
    try:
        with requests.get('https://kinopoiskapiunofficial.tech/api/v2.2/films',params={'keyword':query},headers={'X-API-KEY':settings.KINOPOISK_API_KEY},timeout=8,allow_redirects=False,stream=True) as response:
            response.raise_for_status(); chunks=[]; size=0
            for chunk in response.iter_content(16384):
                size+=len(chunk)
                if size>1024*1024: raise ValueError()
                chunks.append(chunk)
            raw=json.loads(b''.join(chunks))
        rows=raw.get('items',[])
        if not isinstance(rows,list): raise ValueError()
        items=[]
        for item in rows[:8]:
            if not isinstance(item,dict): continue
            items.append({k:item.get(k) for k in ('nameRu','nameEn','year','type','genres','posterUrl','posterUrlPreview')})
        return JsonResponse({'items':items})
    except (requests.RequestException,ValueError,TypeError): return error('Поиск недоступен. Добавьте фильм вручную.',502)


@require_GET
def asset(request,name='index.html'):
    if name not in ('index.html','styles.css','model.js','account.js','app.js'): return error('Не найдено.',404)
    mime='text/html' if name.endswith('.html') else 'text/css' if name.endswith('.css') else 'application/javascript'
    return FileResponse(open(settings.ROOT/name,'rb'),content_type=mime)

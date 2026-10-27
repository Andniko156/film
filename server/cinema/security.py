import hashlib
import hmac
import logging
import secrets
import time
from datetime import timedelta
from functools import wraps
from django.conf import settings
from django.contrib.auth import login
from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from .models import Archive, RateBucket, User


def audit(event, user=None):
    logging.getLogger('film.audit').info('event=%s user=%s', event, user.pk if user else '-')


def digest(value):
    return hmac.new(settings.SECRET_KEY.encode(), value.encode(), hashlib.sha256).hexdigest()


def ip(request):
    # The trusted reverse proxy overwrites this value; never trust X-Forwarded-For chains.
    return request.META.get('HTTP_X_REAL_IP', '') if settings.TRUST_PROXY else request.META.get('REMOTE_ADDR', '')


def allow(scope, value, limit, seconds):
    key = digest(scope + ':' + value)
    now = timezone.now()
    with transaction.atomic():
        RateBucket.objects.get_or_create(key=key, defaults={'expires_at': now + timedelta(seconds=seconds)})
        bucket = RateBucket.objects.select_for_update().get(key=key)
        if bucket.expires_at <= now:
            bucket.count = 0
            bucket.expires_at = now + timedelta(seconds=seconds)
        if bucket.count >= limit:
            return False
        bucket.count += 1
        bucket.save(update_fields=['count','expires_at'])
    return True


def authenticated(methods):
    def decorator(fn):
        @wraps(fn)
        def wrapped(request, *args, **kwargs):
            if request.method not in methods:
                return JsonResponse({'error': 'Метод недоступен.'}, status=405)
            if not request.user.is_authenticated:
                return JsonResponse({'error': 'Войдите в аккаунт.'}, status=401)
            if request.headers.get('X-Film-Account') != request.user.username:
                return JsonResponse({'error': 'Аккаунт изменился. Обновите страницу.', 'accountChanged': True}, status=409)
            return fn(request, *args, **kwargs)
        return wrapped
    return decorator


def create_user():
    user = User(username=secrets.token_hex(16))
    user.set_unusable_password()
    user.save()
    Archive.objects.create(user=user)
    return user


def establish(request, user):
    login(request, user, backend='django.contrib.auth.backends.ModelBackend')
    now = int(time.time())
    request.session.update({'auth_at': now, 'last_seen': now, 'recent_auth': now, 'user_version': user.session_version})
    audit('login', user)

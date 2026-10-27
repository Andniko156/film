import os
from pathlib import Path
from urllib.parse import urlparse
from django.core.exceptions import ImproperlyConfigured

ROOT = Path(__file__).resolve().parent.parent
DEV = os.getenv('FILM_DEV') == '1'
TESTING = os.getenv('FILM_TEST') == '1'
SECRET_KEY = os.getenv('DJANGO_SECRET_KEY', '')
if not SECRET_KEY and (DEV or TESTING):
    SECRET_KEY = 'development-only-never-use-this-key-in-production'
if len(SECRET_KEY) < 40:
    raise ImproperlyConfigured('Set a random DJANGO_SECRET_KEY of at least 40 characters')
DEBUG = False
PUBLIC_ORIGIN = os.getenv('PUBLIC_ORIGIN', 'http://localhost:8000' if DEV or TESTING else '')
origin = urlparse(PUBLIC_ORIGIN)
if not origin.hostname or (not DEV and not TESTING and origin.scheme != 'https') or origin.path not in ('', '/'):
    raise ImproperlyConfigured('PUBLIC_ORIGIN must be an HTTPS origin without a path')
ALLOWED_HOSTS = [origin.hostname] + (['testserver', 'localhost', '127.0.0.1'] if TESTING or DEV else [])
CSRF_TRUSTED_ORIGINS = [PUBLIC_ORIGIN]
INSTALLED_APPS = ['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions', 'cinema']
MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'cinema.middleware.SecurityHeaders',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'cinema.middleware.SessionLifetime',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]
ROOT_URLCONF = 'urls'
WSGI_APPLICATION = 'wsgi.application'
AUTH_USER_MODEL = 'cinema.User'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
USE_TZ = True
TIME_ZONE = 'UTC'
LANGUAGE_CODE = 'ru'
if os.getenv('PGHOST'):
    DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql', 'NAME': os.environ['PGDATABASE'],
        'USER': os.environ['PGUSER'], 'PASSWORD': os.environ['PGPASSWORD'], 'HOST': os.environ['PGHOST'],
        'PORT': os.getenv('PGPORT', '5432'), 'CONN_MAX_AGE': 60,
        'OPTIONS': {'sslmode': os.getenv('PGSSLMODE', 'verify-full'), 'connect_timeout': 5}}}
elif DEV or TESTING:
    DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': os.getenv('SQLITE_PATH', str(ROOT / 'server/dev.sqlite3'))}}
else:
    raise ImproperlyConfigured('PostgreSQL is required in production')
SESSION_COOKIE_NAME = 'film_session' if DEV or TESTING else '__Host-film_session'
SESSION_COOKIE_SECURE = not (DEV or TESTING)
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
SESSION_COOKIE_AGE = 7 * 24 * 3600
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
CSRF_COOKIE_HTTPONLY = True  # csrf token is delivered by /api/session, never from JS cookies
CSRF_COOKIE_SAMESITE = 'Lax'
CSRF_FAILURE_VIEW = 'cinema.views.csrf_failure'
SESSION_IDLE_SECONDS = 24 * 3600
SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600
SECURE_SSL_REDIRECT = not (DEV or TESTING)
# Trust these headers only behind the bundled Caddy; app port must not be public.
TRUST_PROXY = os.getenv('TRUST_PROXY') == '1'
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https') if TRUST_PROXY else None
SECURE_HSTS_SECONDS = 31536000 if not (DEV or TESTING) else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'no-referrer'
X_FRAME_OPTIONS = 'DENY'
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024
DATA_UPLOAD_MAX_NUMBER_FIELDS = 100
EMAIL_BACKEND = 'django.core.mail.backends.smtp.EmailBackend'
if TESTING:
    EMAIL_BACKEND = 'django.core.mail.backends.locmem.EmailBackend'
EMAIL_HOST = os.getenv('SMTP_HOST', '')
EMAIL_PORT = int(os.getenv('SMTP_PORT', '587'))
EMAIL_HOST_USER = os.getenv('SMTP_USER', '')
EMAIL_HOST_PASSWORD = os.getenv('SMTP_PASSWORD', '')
EMAIL_USE_SSL = os.getenv('SMTP_SSL') == '1'
EMAIL_USE_TLS = not EMAIL_USE_SSL
EMAIL_TIMEOUT = 10
DEFAULT_FROM_EMAIL = os.getenv('MAIL_FROM', '')
MAIL_ENABLED = bool(EMAIL_HOST and DEFAULT_FROM_EMAIL) or TESTING
YANDEX_CLIENT_ID = os.getenv('YANDEX_CLIENT_ID', '')
YANDEX_CLIENT_SECRET = os.getenv('YANDEX_CLIENT_SECRET', '')
YANDEX_REDIRECT_URI = PUBLIC_ORIGIN.rstrip('/') + '/api/auth/yandex/callback'
KINOPOISK_API_KEY = os.getenv('KINOPOISK_API_KEY', '')
# Avoid request URLs, body, query parameters, mail content and provider tokens in logs.
LOGGING = {'version': 1, 'disable_existing_loggers': False,
    'handlers': {'null': {'class': 'logging.NullHandler'}, 'console': {'class': 'logging.StreamHandler'}},
    'loggers': {'django.request': {'handlers': ['null'], 'propagate': False},
                'django.server': {'handlers': ['null'], 'propagate': False},
                'film.audit': {'handlers': ['console'], 'level': 'INFO', 'propagate': False}}}

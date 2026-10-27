import time
from django.conf import settings
from django.contrib.auth import logout


class SecurityHeaders:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response['Content-Security-Policy'] = (
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' https: data:; connect-src 'self'; font-src 'self'; "
            "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'")
        response['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
        response['Referrer-Policy'] = 'no-referrer'
        if request.path.startswith('/api/') or request.path == '/':
            response['Cache-Control'] = 'no-store, private'
        return response


class SessionLifetime:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.user.is_authenticated:
            now = int(time.time())
            issued = request.session.get('auth_at', 0)
            seen = request.session.get('last_seen', 0)
            if (request.session.get('user_version') != request.user.session_version or
                now - issued > settings.SESSION_ABSOLUTE_SECONDS or now - seen > settings.SESSION_IDLE_SECONDS):
                logout(request)
            elif now - seen > 300:
                request.session['last_seen'] = now
        return self.get_response(request)

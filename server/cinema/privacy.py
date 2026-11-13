import hashlib
from datetime import datetime

from django.conf import settings
from django.template.loader import render_to_string
from django.utils import timezone

from .models import PrivacyConsent


def metadata():
    return {
        'enabled': settings.PRIVACY_ENABLED,
        'operator': settings.PRIVACY_OPERATOR,
        'address': settings.PRIVACY_ADDRESS,
        'email': settings.PRIVACY_EMAIL,
        'hosting': settings.PRIVACY_HOSTING,
        'mail_provider': settings.PRIVACY_MAIL_PROVIDER,
        'backup_days': settings.PRIVACY_BACKUP_DAYS,
        'audit_days': settings.PRIVACY_AUDIT_DAYS,
    }


def consent_document():
    document = render_to_string('privacy/consent_text.html', metadata())
    version = hashlib.sha256(document.encode()).hexdigest()
    return document, version


def acceptance(value):
    """Require an explicit affirmation of the exact text offered by this server."""
    if not settings.PRIVACY_ENABLED:
        return None
    document, version = consent_document()
    if value != version:
        raise ValueError('Откройте актуальный текст и отдельно подтвердите согласие на обработку персональных данных.')
    return {'version': version, 'document': document, 'acceptedAt': timezone.now().isoformat()}


def current(proof):
    return not settings.PRIVACY_ENABLED or (proof and proof['version'] == consent_document()[1])


def record(user, proof, source):
    if proof:
        PrivacyConsent.objects.get_or_create(user=user, version=proof['version'], source=source, defaults={
            'document': proof['document'], 'accepted_at': datetime.fromisoformat(proof['acceptedAt']),
        })

from django.core.management import BaseCommand, call_command
from django.utils import timezone
from cinema.models import EmailChallenge, RateBucket

class Command(BaseCommand):
    help = 'Remove expired OTP challenges, rate buckets and sessions; run daily.'
    def handle(self, **options):
        EmailChallenge.objects.filter(expires_at__lt=timezone.now()).delete()
        RateBucket.objects.filter(expires_at__lt=timezone.now()).delete()
        call_command('clearsessions')
        self.stdout.write('Expired authentication data removed.')

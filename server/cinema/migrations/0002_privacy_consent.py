from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('cinema', '0001_initial')]

    operations = [
        migrations.AddField(
            model_name='emailchallenge', name='privacy_proof',
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.CreateModel(
            name='PrivacyConsent',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('version', models.CharField(max_length=64)),
                ('document', models.TextField()),
                ('source', models.CharField(max_length=12)),
                ('accepted_at', models.DateTimeField()),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='privacy_consents', to=settings.AUTH_USER_MODEL)),
            ],
            options={'constraints': [models.UniqueConstraint(fields=('user', 'version', 'source'), name='unique_privacy_consent')]},
        ),
    ]

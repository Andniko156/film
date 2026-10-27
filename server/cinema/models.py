import uuid
from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    # Username is an opaque UUID; credentials live in verified Identity records.
    session_version = models.PositiveIntegerField(default=0)


class Identity(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='identities')
    provider = models.CharField(max_length=10)
    subject = models.CharField(max_length=254)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['provider', 'subject'], name='unique_identity'),
                       models.UniqueConstraint(fields=['user', 'provider'], name='one_provider_per_user')]


class EmailChallenge(models.Model):
    email = models.CharField(max_length=254, unique=True)
    nonce = models.UUIDField(default=uuid.uuid4)
    digest = models.CharField(max_length=64)
    expires_at = models.DateTimeField()
    attempts = models.PositiveSmallIntegerField(default=0)
    consumed = models.BooleanField(default=False)
    # A linking code is bound to both the signed-in user and their current session.
    link_user = models.ForeignKey(User, null=True, on_delete=models.CASCADE)
    session_digest = models.CharField(max_length=64, blank=True)


class RateBucket(models.Model):
    key = models.CharField(max_length=64, unique=True)
    count = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField(db_index=True)


class Archive(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, primary_key=True)
    revision = models.PositiveBigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)


class Movie(models.Model):
    archive = models.ForeignKey(Archive, on_delete=models.CASCADE, related_name='movies')
    local_id = models.CharField(max_length=160)
    position = models.PositiveIntegerField()
    data = models.JSONField()  # personal metadata; all fields validated on API boundary

    class Meta:
        constraints = [models.UniqueConstraint(fields=['archive', 'local_id'], name='movie_local_id')]
        ordering = ['position']


class Watch(models.Model):
    movie = models.ForeignKey(Movie, on_delete=models.CASCADE, related_name='watches')
    local_id = models.CharField(max_length=160)
    position = models.PositiveIntegerField()
    data = models.JSONField()

    class Meta:
        ordering = ['position']


class Quote(models.Model):
    movie = models.ForeignKey(Movie, on_delete=models.CASCADE, related_name='quotes')
    local_id = models.CharField(max_length=160)
    position = models.PositiveIntegerField()
    data = models.JSONField()

    class Meta:
        ordering = ['position']


class Collection(models.Model):
    archive = models.ForeignKey(Archive, on_delete=models.CASCADE, related_name='collections')
    local_id = models.CharField(max_length=160)
    position = models.PositiveIntegerField()
    data = models.JSONField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=['archive', 'local_id'], name='collection_local_id')]
        ordering = ['position']


class CollectionItem(models.Model):
    collection = models.ForeignKey(Collection, on_delete=models.CASCADE, related_name='items')
    movie = models.ForeignKey(Movie, on_delete=models.CASCADE)
    position = models.PositiveIntegerField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=['collection', 'movie'], name='unique_collection_movie')]
        ordering = ['position']


class Preset(models.Model):
    archive = models.ForeignKey(Archive, on_delete=models.CASCADE, related_name='presets')
    local_id = models.CharField(max_length=160)
    position = models.PositiveIntegerField()
    data = models.JSONField()

    class Meta:
        ordering = ['position']


class ImportReceipt(models.Model):
    archive = models.ForeignKey(Archive, on_delete=models.CASCADE)
    digest = models.CharField(max_length=64)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['archive', 'digest'], name='unique_import')]

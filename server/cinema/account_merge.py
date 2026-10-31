"""Conservative account merge: preserve every record, never overwrite personal data."""
import copy
import secrets
from django.db import transaction
from . import archive as store
from .validation import validate
from .models import Archive, Identity, User

KINDS = ('movies','views','quotes','collections','presets')

def counts(data):
    return {key:len(data[key]) for key in KINDS}

def combine(primary, secondary):
    result=copy.deepcopy(primary)
    source=copy.deepcopy(secondary)
    movie_ids={m['id'] for m in result['movies']}
    collection_ids={m['id'] for m in result['collections']}
    rename_movies={}
    rename_collections={}
    for key in KINDS:
        used={row['id'] for row in result[key]}
        for row in source[key]:
            old=row['id']
            if old in used:
                new='merged_'+secrets.token_hex(12)
                while new in used: new='merged_'+secrets.token_hex(12)
                row['id']=new
            used.add(row['id'])
            if key=='movies':rename_movies[old]=row['id']
            if key=='collections':rename_collections[old]=row['id']
    for key in ('views','quotes'):
        for row in source[key]:row['movieId']=rename_movies[row['movieId']]
    for row in source['collections']:
        row['movieIds']=[rename_movies[mid] for mid in row['movieIds']]
    for row in source['presets']:
        selected=row['filters']['collection']
        if selected:row['filters']['collection']=rename_collections[selected]
    for key in KINDS:result[key].extend(source[key])
    return validate(result)

def merge_into(primary_id, secondary_id, provider, subject, expected_revision, expected_secondary_revision):
    """Run inside transaction. Source user and archive retained inactive for recovery."""
    with transaction.atomic():
        users=list(User.objects.select_for_update().filter(pk__in=[primary_id,secondary_id]).order_by('pk'))
        if len(users)!=2 or primary_id==secondary_id:raise ValueError('Аккаунты недоступны.')
        primary=next(u for u in users if u.pk==primary_id)
        secondary=next(u for u in users if u.pk==secondary_id)
        if not primary.is_active or not secondary.is_active:raise ValueError('Аккаунт недоступен.')
        archives={a.user_id:a for a in Archive.objects.select_for_update().filter(user_id__in=[primary_id,secondary_id]).order_by('user_id')}
        main=archives[primary_id];other=archives[secondary_id]
        if main.revision!=expected_revision or other.revision!=expected_secondary_revision:
            raise ValueError('Один из архивов изменился. Обновите страницу и проверьте сведения заново.')
        linked=Identity.objects.select_for_update().get(provider=provider,subject=subject)
        if linked.user_id!=secondary_id:raise ValueError('Привязка изменилась.')
        if Identity.objects.filter(user_id=primary_id,provider=provider).exists():raise ValueError('Способ входа уже привязан.')
        # Only merge an external provider-only account. Other credentials require a separate approval flow.
        if Identity.objects.filter(user_id=secondary_id).exclude(pk=linked.pk).exists() or secondary.has_usable_password():
            raise ValueError('Второй аккаунт имеет другие способы входа. Автоматическое объединение недоступно.')
        combined=combine(store.read(main),store.read(other))
        store.replace(main,combined)
        linked.user=primary
        linked.save(update_fields=['user'])
        secondary.is_active=False
        secondary.session_version+=1
        secondary.save(update_fields=['is_active','session_version'])
        return counts(combined)

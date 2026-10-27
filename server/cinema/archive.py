import hashlib
import json
from .models import Movie, Watch, Quote, Collection, CollectionItem, Preset


def fingerprint(data):
    content = {key: value for key, value in data.items() if key not in ('revision', 'exportedAt')}
    return hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def read(archive):
    data = {'version': 2, 'revision': archive.revision}
    data['movies'] = [m.data for m in archive.movies.all()]
    data['views'] = [v.data for v in Watch.objects.filter(movie__archive=archive)]
    data['quotes'] = [q.data for q in Quote.objects.filter(movie__archive=archive)]
    data['collections'] = [dict(c.data, movieIds=[i.movie.local_id for i in c.items.all()])
                           for c in archive.collections.prefetch_related('items__movie')]
    data['presets'] = [p.data for p in archive.presets.all()]
    return data


def replace(archive, data):
    # Caller MUST hold select_for_update on Archive inside transaction.atomic.
    archive.collections.all().delete()
    archive.movies.all().delete()
    archive.presets.all().delete()
    movies = Movie.objects.bulk_create([Movie(archive=archive, local_id=m['id'], position=i, data=m) for i,m in enumerate(data['movies'])])
    by_id = {m.local_id: m for m in movies}
    Watch.objects.bulk_create([Watch(movie=by_id[v['movieId']], local_id=v['id'], position=i, data=v) for i,v in enumerate(data['views'])])
    Quote.objects.bulk_create([Quote(movie=by_id[q['movieId']], local_id=q['id'], position=i, data=q) for i,q in enumerate(data['quotes'])])
    collections = Collection.objects.bulk_create([Collection(archive=archive, local_id=c['id'], position=i, data={k:v for k,v in c.items() if k!='movieIds'}) for i,c in enumerate(data['collections'])])
    CollectionItem.objects.bulk_create([CollectionItem(collection=c, movie=by_id[mid], position=i)
        for c, raw in zip(collections, data['collections']) for i,mid in enumerate(raw['movieIds'])])
    Preset.objects.bulk_create([Preset(archive=archive, local_id=p['id'], position=i, data=p) for i,p in enumerate(data['presets'])])
    archive.revision += 1
    archive.save(update_fields=['revision', 'updated_at'])

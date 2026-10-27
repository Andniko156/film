"""Strict allowlist for the v2 browser archive. No client-supplied owners or DB ids."""
import datetime
import re
from urllib.parse import urlparse

LISTS = ('movies', 'views', 'quotes', 'collections', 'presets')
FILTERS = ('query', 'type', 'genre', 'rating', 'from', 'to', 'quotes', 'notes', 'repeat', 'tag', 'company', 'mood', 'collection', 'sort')


def invalid():
    raise ValueError('Некорректный архив. Проверьте поля, размеры и связи записей.')


def fields(obj, expected):
    if not isinstance(obj, dict) or set(obj) != set(expected):
        invalid()


def string(value, limit, required=False):
    if not isinstance(value, str) or len(value) > limit or '\x00' in value or (required and not value.strip()):
        invalid()


def tags(value):
    if not isinstance(value, list) or len(value) > 50:
        invalid()
    for tag in value:
        string(tag, 100, True)


def date(value):
    string(value, 10)
    if value:
        try:
            if datetime.date.fromisoformat(value).isoformat() != value:
                invalid()
        except ValueError:
            invalid()


def validate(data):
    if not isinstance(data, dict):
        invalid()
    # exportedAt is informational and deliberately not persisted.
    data = {k: v for k, v in data.items() if k != 'exportedAt'}
    fields(data, ('version', 'revision', *LISTS))
    if type(data['version']) is not int or data['version'] != 2 or type(data['revision']) is not int or not 0 <= data['revision'] <= 2**53-1:
        invalid()
    ids = {}
    for name in LISTS:
        rows = data[name]
        if not isinstance(rows, list) or len(rows) > {'movies': 5000, 'views': 20000, 'quotes': 20000, 'collections': 500, 'presets': 100}[name]:
            invalid()
        ids[name] = set()
        for row in rows:
            if not isinstance(row, dict): invalid()
            key = row.get('id')
            string(key, 160, True)
            if not re.fullmatch(r'[\w.-]+', key) or key in ids[name]: invalid()
            ids[name].add(key)
    for m in data['movies']:
        fields(m, ('id', 'title', 'type', 'year', 'genre', 'poster', 'createdAt', 'tags', 'planned'))
        for key, limit in [('title',300),('year',20),('genre',500),('poster',2000),('createdAt',80)]: string(m[key],limit,key=='title')
        if m['type'] not in ('FILM','TV_SERIES','MINI_SERIES','TV_SHOW') or type(m['planned']) is not bool: invalid()
        if m['poster']:
            url = urlparse(m['poster'])
            if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password: invalid()
        tags(m['tags'])
    for v in data['views']:
        fields(v, ('id','movieId','date','rating','note','company','mood','createdAt'))
        if not isinstance(v['movieId'], str) or v['movieId'] not in ids['movies']: invalid()
        date(v['date'])
        if type(v['rating']) is not int or not 0 <= v['rating'] <= 5: invalid()
        for key, limit in [('note',20000),('company',300),('mood',300),('createdAt',80)]: string(v[key],limit)
    for q in data['quotes']:
        fields(q, ('id','movieId','text','character','time','note','tags','spoiler','createdAt'))
        if not isinstance(q['movieId'], str) or q['movieId'] not in ids['movies'] or type(q['spoiler']) is not bool: invalid()
        for key, limit in [('text',10000),('character',300),('time',20),('note',20000),('createdAt',80)]: string(q[key],limit,key=='text')
        if q['time'] and not re.fullmatch(r'(\d{1,2}:)?[0-5]\d:[0-5]\d', q['time']): invalid()
        tags(q['tags'])
    for c in data['collections']:
        fields(c, ('id','name','description','movieIds'))
        string(c['name'],150,True); string(c['description'],3000)
        if not isinstance(c['movieIds'],list) or any(not isinstance(x,str) for x in c['movieIds']): invalid()
        if len(set(c['movieIds'])) != len(c['movieIds']) or not set(c['movieIds']) <= ids['movies']: invalid()
    for p in data['presets']:
        fields(p, ('id','name','filters')); string(p['name'],120,True); fields(p['filters'], FILTERS)
        for value in p['filters'].values(): string(value,500)
        f = p['filters']
        if f['collection'] and f['collection'] not in ids['collections']: invalid()
        if f['type'] not in ('','FILM','TV_SERIES','MINI_SERIES','TV_SHOW') or f['sort'] not in ('recent','oldest','title','rating'): invalid()
        if f['rating'] not in ('','1','2','3','4','5'): invalid()
        if any(f[k] not in ('','yes','no') for k in ('quotes','notes','repeat')): invalid()
        date(f['from']); date(f['to'])
    return data

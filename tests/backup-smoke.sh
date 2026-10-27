#!/bin/bash
# Disposable CI databases only. Never run against production.
set -euo pipefail
: "${PGDATABASE:?}"
if [[ "$PGDATABASE" != film_ci ]]; then
  echo 'This test only accepts PGDATABASE=film_ci' >&2; exit 1
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
age-keygen -o "$work/identity.agekey" 2>/dev/null
export AGE_RECIPIENT
AGE_RECIPIENT=$(age-keygen -y "$work/identity.agekey")
export BACKUP_DIR="$work/backups"
python server/manage.py shell -c "from cinema.security import create_user; from cinema import archive; from cinema.models import Archive; from cinema.tests import fixture; from django.db import transaction; u=create_user(); a=Archive.objects.get(user=u); exec('with transaction.atomic():\n archive.replace(a,fixture())')"
bash deploy/backup.sh
createdb film_ci_restore
age -d -i "$work/identity.agekey" "$BACKUP_DIR"/*.dump.age | pg_restore --exit-on-error --no-owner --no-acl --dbname=film_ci_restore
before=$(psql -At -c 'SELECT count(*) FROM cinema_quote')
after=$(PGDATABASE=film_ci_restore psql -At -c 'SELECT count(*) FROM cinema_quote')
test "$before" = "$after"
test "$after" -gt 0
PGDATABASE=film_ci_restore python server/manage.py shell -c "from cinema.models import Archive; from cinema.archive import read; from cinema.validation import validate; [validate(read(a)) for a in Archive.objects.all()]; print('Restored archives validated')"
dropdb film_ci_restore
# A failing pg_dump must not leave a completed encrypted backup.
mkdir "$work/bin"
printf '#!/bin/sh\nexit 42\n' > "$work/bin/pg_dump"
chmod +x "$work/bin/pg_dump"
if PATH="$work/bin:$PATH" BACKUP_DIR="$work/broken" bash deploy/backup.sh; then
  echo 'Broken pg_dump incorrectly reported success' >&2;exit 1
fi
test -z "$(find "$work/broken" -type f -name '*.age' -print)"
echo 'Encrypted backup restored and validated; partial backups rejected.'

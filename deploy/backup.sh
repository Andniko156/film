#!/bin/bash
set -euo pipefail
umask 077
: "${AGE_RECIPIENT:?Set the age PUBLIC recipient; never store the private key here}"
: "${BACKUP_DIR:=/backups}"
mkdir -p "$BACKUP_DIR"
name="film-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
temp=$(mktemp "$BACKUP_DIR/.backup-XXXXXX")
trap 'rm -f "$temp"' EXIT
# pipefail prevents an empty/partial pg_dump from becoming a successful backup.
pg_dump --format=custom --no-owner --no-acl | age -r "$AGE_RECIPIENT" > "$temp"
test -s "$temp"
mv "$temp" "$BACKUP_DIR/$name"
sha256sum "$BACKUP_DIR/$name" > "$BACKUP_DIR/$name.sha256"
# Retention applies only to this task's completed backups.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'film-*.dump.age*' -mtime +30 -delete
printf 'Encrypted backup completed: %s\n' "$name"

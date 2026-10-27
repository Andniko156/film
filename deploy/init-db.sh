#!/bin/bash
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DB_PASSWORD" --set=migrate_password="$MIGRATE_DB_PASSWORD" --set=backup_password="$BACKUP_DB_PASSWORD" <<'SQL'
REVOKE ALL ON DATABASE film FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE ROLE film_migrator LOGIN PASSWORD :'migrate_password';
CREATE ROLE film_app LOGIN PASSWORD :'app_password';
CREATE ROLE film_backup LOGIN PASSWORD :'backup_password';
GRANT CONNECT ON DATABASE film TO film_migrator, film_app, film_backup;
GRANT USAGE, CREATE ON SCHEMA public TO film_migrator;
GRANT USAGE ON SCHEMA public TO film_app, film_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE film_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO film_app;
ALTER DEFAULT PRIVILEGES FOR ROLE film_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO film_app;
ALTER DEFAULT PRIVILEGES FOR ROLE film_migrator IN SCHEMA public GRANT SELECT ON TABLES TO film_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE film_migrator IN SCHEMA public GRANT SELECT ON SEQUENCES TO film_backup;
SQL

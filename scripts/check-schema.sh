#!/usr/bin/env bash
# Applies docs/architecture/sql/*.sql in order to a fresh database on the local Postgres.
# Usage: scripts/check-schema.sh [db_name] [file ...]   (default: all files, db mehfil_schema_check)
set -euo pipefail
DB="${1:-mehfil_schema_check}"; shift || true
export PGHOST="${PGHOST:-localhost}" PGUSER="${PGUSER:-mehfil}" PGPASSWORD="${PGPASSWORD:-mehfil}"
DIR="$(cd "$(dirname "$0")/../docs/architecture/sql" && pwd)"
FILES=("$@"); [ ${#FILES[@]} -eq 0 ] && FILES=("$DIR"/*.sql)
dropdb --if-exists "$DB" && createdb "$DB"
for f in "${FILES[@]}"; do
  echo "applying $(basename "$f")"
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
done
echo "OK: $(psql -At -d "$DB" -c "select count(*) from information_schema.tables where table_schema='public'") tables in $DB"

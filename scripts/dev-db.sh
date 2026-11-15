#!/usr/bin/env bash
# Starts a self-hosted Postgres 16 (no Docker) and creates the dev and test databases.
# Used in the cloud sandbox and on Linux laptops with the postgresql-16 package installed.
set -euo pipefail
if command -v pg_ctlcluster >/dev/null; then
  pg_ctlcluster 16 main start 2>/dev/null || true
fi
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "$1"; else sudo -u postgres sh -c "$1"; fi; }
run "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='mehfil'\" | grep -q 1 || psql -c \"CREATE ROLE mehfil LOGIN PASSWORD 'mehfil' CREATEDB\""
for db in mehfil_dev mehfil_test; do
  run "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$db'\" | grep -q 1 || createdb -O mehfil $db"
done
echo "Postgres ready: postgresql://mehfil:mehfil@localhost:5432/{mehfil_dev,mehfil_test}"

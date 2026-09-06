#!/usr/bin/env bash
# Bring up local Postgres + Mailpit and wait until both are healthy.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d

echo "Waiting for services to become healthy..."
for _ in $(seq 1 60); do
  db=$(docker inspect --format '{{.State.Health.Status}}' waresport_db 2>/dev/null || echo starting)
  mail=$(docker inspect --format '{{.State.Health.Status}}' waresport_mail 2>/dev/null || echo starting)
  if [ "$db" = "healthy" ] && [ "$mail" = "healthy" ]; then
    echo "  db: healthy   mail: healthy"
    echo "Postgres  -> postgres://postgres:postgres@127.0.0.1:54329/waresport"
    echo "Mailpit   -> http://127.0.0.1:54324  (SMTP on 127.0.0.1:54325)"
    exit 0
  fi
  sleep 1
done

echo "Services did not become healthy in time." >&2
docker compose ps >&2
exit 1

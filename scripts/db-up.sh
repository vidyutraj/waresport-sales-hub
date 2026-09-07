#!/usr/bin/env bash
# Bring up local Postgres and wait until it is healthy.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d

echo "Waiting for Postgres to become healthy..."
for _ in $(seq 1 60); do
  db=$(docker inspect --format '{{.State.Health.Status}}' waresport_db 2>/dev/null || echo starting)
  if [ "$db" = "healthy" ]; then
    echo "  db: healthy"
    echo "Postgres  -> postgres://postgres:postgres@127.0.0.1:54329/waresport"
    exit 0
  fi
  sleep 1
done

echo "Postgres did not become healthy in time." >&2
docker compose ps >&2
exit 1

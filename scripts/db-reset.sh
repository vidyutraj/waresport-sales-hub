#!/usr/bin/env bash
# Destroy and recreate the local database volume, then migrate + seed from scratch.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose down -v
bash scripts/db-up.sh
npx tsx scripts/migrate.ts
npx tsx scripts/seed.ts

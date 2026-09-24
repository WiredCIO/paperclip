#!/usr/bin/env bash
# WiredCIO production deploy script for vm-paperclip.
#
# This is the SOLE command the CI deploy SSH key is authorized to run (see
# doc/RELEASING-WIREDCIO.md for the forced-command authorized_keys entry that
# enforces this). It intentionally does not accept arguments: the deploy key
# has no other capability, so the command it runs must be self-contained.
#
# docker-compose.managed.yml and .env.prod are VM-local, hand-authored files
# that are NOT tracked in git (see doc/RELEASING-WIREDCIO.md for why). This
# script never writes to either -- it only reads them, exactly as the manual
# runbook always has.
set -euo pipefail

cd /opt/paperclip

echo "==> Fetching wiredcio/deploy"
git fetch origin wiredcio/deploy
before_sha="$(git rev-parse HEAD)"
git reset --hard origin/wiredcio/deploy
after_sha="$(git rev-parse HEAD)"

if [ "$before_sha" = "$after_sha" ]; then
  echo "==> Already at ${after_sha}, nothing to deploy"
  exit 0
fi

echo "==> Deploying ${before_sha} -> ${after_sha}"

echo "==> Building server image"
docker compose --env-file .env.prod -f docker-compose.managed.yml build server

echo "==> Restarting server"
docker compose --env-file .env.prod -f docker-compose.managed.yml up -d server

echo "==> Waiting for health check"
health_url="http://localhost:${PORT:-3100}/api/health"
for attempt in $(seq 1 30); do
  if status="$(curl -fsS -o /tmp/wiredcio-deploy-health.json -w '%{http_code}' "$health_url" 2>/dev/null)"; then
    if [ "$status" = "200" ]; then
      echo "==> Healthy after ${attempt} attempt(s):"
      cat /tmp/wiredcio-deploy-health.json
      echo
      exit 0
    fi
  fi
  sleep 2
done

echo "==> FAILED: server did not report healthy within 60s after deploying ${after_sha}" >&2
echo "==> Rolling back to ${before_sha}" >&2
git reset --hard "$before_sha"
docker compose --env-file .env.prod -f docker-compose.managed.yml build server
docker compose --env-file .env.prod -f docker-compose.managed.yml up -d server
exit 1

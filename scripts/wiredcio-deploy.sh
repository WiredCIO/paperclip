#!/usr/bin/env bash
# WiredCIO production deploy script for vm-paperclip.
#
# Runs directly on the self-hosted GitHub Actions runner installed on this
# VM (see doc/RELEASING-WIREDCIO.md). It intentionally does not accept
# arguments beyond its own re-exec bookkeeping.
#
# docker-compose.managed.yml (in docker/) and .env.prod (one level up, at the
# repo root) are VM-local, hand-authored files that are NOT tracked in git
# (see doc/RELEASING-WIREDCIO.md for why). This script never writes to
# either -- it only reads them, exactly as the manual runbook always has.
set -euo pipefail

cd /opt/paperclip
COMPOSE_FILE=docker/docker-compose.managed.yml

if [ "${WIREDCIO_DEPLOY_REEXECED:-}" != "1" ]; then
  echo "==> Fetching wiredcio/deploy"
  # Use whatever remote this checkout's branch actually tracks rather than
  # assuming a remote name -- this checkout names the WiredCIO fork "fork"
  # and "origin" points at upstream paperclipai/paperclip, which is the
  # opposite of what a fresh clone would usually be named.
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name @{u})"
  git fetch "${upstream%%/*}"
  before_sha="$(git rev-parse HEAD)"
  git reset --hard "$upstream"
  after_sha="$(git rev-parse HEAD)"

  if [ "$before_sha" = "$after_sha" ]; then
    echo "==> Already at ${after_sha}, nothing to deploy"
    exit 0
  fi

  echo "==> Deploying ${before_sha} -> ${after_sha}"
  # The git reset above just rewrote this very file on disk. bash already
  # read the whole script into memory before running it, so without this
  # re-exec every deploy would keep running last run's script -- permanently
  # one commit behind its own fixes, which is exactly what happened across
  # the #53/#54 rollout (a fix would only take effect on the *next* push).
  # Hand off to a fresh process that reads the file fresh off disk.
  exec env WIREDCIO_DEPLOY_REEXECED=1 WIREDCIO_DEPLOY_BEFORE_SHA="$before_sha" "$0"
fi

before_sha="${WIREDCIO_DEPLOY_BEFORE_SHA:?}"
after_sha="$(git rev-parse HEAD)"

echo "==> Building server image"
docker compose --env-file .env.prod -f "$COMPOSE_FILE" build server

echo "==> Restarting server"
docker compose --env-file .env.prod -f "$COMPOSE_FILE" up -d server

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
docker compose --env-file .env.prod -f "$COMPOSE_FILE" build server
docker compose --env-file .env.prod -f "$COMPOSE_FILE" up -d server
exit 1

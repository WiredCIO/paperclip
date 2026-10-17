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
health_url="http://localhost:${PORT:-3100}/api/health"
health_body=/tmp/wiredcio-deploy-health.json

# The commit that last came up healthy. It lives inside .git so `git reset
# --hard` never touches it and it can never be committed by accident. Git
# HEAD alone cannot answer "is production running this commit?": on
# 2026-10-17 the build for #92 died on a full disk after HEAD had already
# moved, and every later run saw HEAD == upstream and reported "nothing to
# deploy" while the old container kept running.
deployed_marker="$(git rev-parse --git-dir)/wiredcio-deployed-sha"

# Print the commit production is actually running: the commit the live
# server reports in /api/health (the image is stamped with it at build time,
# below), else the marker. Prints nothing when neither is known.
running_sha() {
  local sha=""
  if curl -fsS -o "$health_body" "$health_url" 2>/dev/null; then
    sha="$(grep -o '"commit":"[0-9a-f]\{40\}"' "$health_body" | head -n1 | cut -d'"' -f4 || true)"
  fi
  if [ -z "$sha" ] && [ -f "$deployed_marker" ]; then
    sha="$(tr -d '[:space:]' <"$deployed_marker")"
  fi
  printf '%s' "$sha"
}

if [ "${WIREDCIO_DEPLOY_REEXECED:-}" != "1" ]; then
  echo "==> Fetching wiredcio/deploy"
  # Use whatever remote this checkout's branch actually tracks rather than
  # assuming a remote name -- this checkout names the WiredCIO fork "fork"
  # and "origin" points at upstream paperclipai/paperclip, which is the
  # opposite of what a fresh clone would usually be named.
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name @{u})"
  git fetch "${upstream%%/*}"
  head_sha="$(git rev-parse HEAD)"
  running="$(running_sha)"
  # Roll back to what is really running when that is known. Otherwise fall
  # back to the pre-fetch HEAD, which is right whenever the last deploy
  # finished -- the only case before the running commit was recorded.
  before_sha="${running:-$head_sha}"
  git reset --hard "$upstream"
  after_sha="$(git rev-parse HEAD)"

  if [ "$running" = "$after_sha" ]; then
    echo "==> Production already running ${after_sha}, nothing to deploy"
    exit 0
  fi
  if [ -z "$running" ]; then
    echo "==> Running commit unknown (no stamp in /api/health, no ${deployed_marker}); deploying ${after_sha}"
  elif [ "$head_sha" = "$after_sha" ]; then
    echo "==> Checkout is at ${after_sha} but production is running ${running}; a previous deploy did not finish"
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

compose() {
  docker compose --env-file .env.prod -f "$COMPOSE_FILE" "$@"
}

# Stamp the image with the commit it was built from, so /api/health reports
# it and the next run can tell what production is really running.
build_server() {
  compose build --build-arg "PAPERCLIP_BUILD_COMMIT=$1" server
}

# The VM disk sits at ~88-96% and the 2026-10-17 deploy of #92 died exporting
# the image with "no space left on device". Trim the build cache to a cap
# before building. Never let the prune itself fail a deploy.
BUILD_CACHE_KEEP="${WIREDCIO_DEPLOY_BUILD_CACHE_KEEP:-10gb}"
echo "==> Pruning build cache down to ${BUILD_CACHE_KEEP}"
docker builder prune -f --keep-storage "$BUILD_CACHE_KEEP" || echo "==> WARN: build cache prune failed; building anyway" >&2

echo "==> Building server image"
# Under `set -e` a failed build used to exit right here, before any rollback,
# leaving the checkout at the new commit while the old container kept running.
# Nothing has been restarted yet, so the old container is still serving: put
# the checkout back and fail the job loudly.
if ! build_server "$after_sha"; then
  echo "==> FAILED: building ${after_sha}; the running server was not touched" >&2
  df -h / /var/lib/docker 2>/dev/null >&2 || true
  echo "==> Resetting checkout to ${before_sha}" >&2
  git reset --hard "$before_sha"
  exit 1
fi

# The server binds its listener well after the container starts: migrations,
# then a startup-recovery pass that git-scans every execution workspace. On
# 2026-09-25 a healthy server took 89s to bind and 100s to finish recovery,
# against a 60s budget -- so the deploy of 826f5128d was rolled back while it
# was still coming up, and nothing was wrong with it. The budget has to clear
# the slowest honest start, not the fastest.
HEALTH_ATTEMPTS=150
HEALTH_INTERVAL=2

wait_for_health() {
  local attempts=$1 status attempt
  for attempt in $(seq 1 "$attempts"); do
    if status="$(curl -fsS -o "$health_body" -w '%{http_code}' "$health_url" 2>/dev/null)"; then
      if [ "$status" = "200" ]; then
        echo "==> Healthy after $((attempt * HEALTH_INTERVAL))s:"
        cat "$health_body"
        echo
        return 0
      fi
    fi
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

echo "==> Restarting server"
if compose up -d server; then
  echo "==> Waiting for health check (up to $((HEALTH_ATTEMPTS * HEALTH_INTERVAL))s)"
  if wait_for_health "$HEALTH_ATTEMPTS"; then
    echo "$after_sha" >"$deployed_marker"
    exit 0
  fi
  echo "==> FAILED: server did not report healthy within $((HEALTH_ATTEMPTS * HEALTH_INTERVAL))s after deploying ${after_sha}" >&2
else
  # `up -d` may already have stopped the old container, so this needs the
  # full rollback, not just a checkout reset.
  echo "==> FAILED: docker compose up -d server for ${after_sha}" >&2
fi

# Dump the logs before rolling back. Compose recreates the container and
# buildkit prunes the untagged image, so once the rollback runs there is
# nothing left to post-mortem -- which is exactly the hole that made the
# 826f5128d failure take a VM session to diagnose instead of one log read.
echo "==> Server logs before rollback:" >&2
compose logs --no-color --tail=200 server >&2 || true

# With no record of what was running (the first run after the running commit
# started being recorded), before_sha falls back to the checkout, which can
# be this same commit. Rebuilding it would just redeploy the failure.
if [ "$before_sha" = "$after_sha" ]; then
  echo "==> CRITICAL: no known-good commit to roll back to (previous running commit was not recorded) -- production may be down" >&2
  compose ps server >&2 || true
  exit 1
fi

echo "==> Rolling back to ${before_sha}" >&2
git reset --hard "$before_sha"
if ! build_server "$before_sha" || ! compose up -d server; then
  echo "==> CRITICAL: rollback build/restart of ${before_sha} failed -- production may be down" >&2
  compose ps server >&2 || true
  exit 1
fi

# The rollback was previously unverified: the script exited 1 the moment the
# container was handed back to compose, so a rollback that ALSO failed to come
# up looked identical to one that worked.
echo "==> Waiting for the rollback to report healthy" >&2
if wait_for_health "$HEALTH_ATTEMPTS"; then
  echo "$before_sha" >"$deployed_marker"
  echo "==> Rolled back to ${before_sha} and healthy" >&2
else
  echo "==> CRITICAL: rollback to ${before_sha} is NOT healthy -- production is down" >&2
  compose logs --no-color --tail=200 server >&2 || true
fi
exit 1

# Build the production image in CI, not on vm-paperclip

Status: implemented in the PR that adds this file, 2026-11-06

## Problem

Every merge to `wiredcio/deploy` runs `/opt/paperclip/scripts/wiredcio-deploy.sh` on the
self-hosted runner on vm-paperclip. That script runs `docker compose build server` on the
production box, then `compose up -d server`.

On 2026-11-06 the deploy of #159/#160 failed three times in a row. Twice the disk filled
("no space left on device" at `COPY --from=runner-provider-pack`). The third time the job's
`timeout-minutes: 20` cancelled it. While the fix was stuck, ConnectAbility D365 Agent hung
in `pausing` twice more, so the fix it needed could not ship.

Where the time goes (attempt 2 of run 42291135591, 22:49 → 23:05):

| Step | Time |
|---|---|
| Rust toolchain: apt gcc, rustup, `cargo install cargo-chef` | ~2.5 min |
| `cargo chef cook` (runner dependencies) | 3.1 min |
| `cargo build --release` (paperclip-runnerd) | 1+ min |
| `pnpm install` | 2.2 min |
| `COPY /app` between stages (twice) | ~3.5 min |
| Provider pack and Kimi smoke | 3.2 min |
| Server TS build, runtime bundle, plugins | ~2 min |
| Final image export | did not finish |

Why it is that slow:

1. **The deploy script throws its own cache away.** It runs
   `docker builder prune -f --keep-storage 10gb` before every build. A full build leaves
   about 28 GB of cache, so most layers are evicted each time. Only 7 steps were cached.
2. **The image is 16.8 GB.** The `production` stage copies all of `/app` from `build`
   (dev dependencies, sources, build output). The copy and export take minutes, and they
   are also what fills the disk.
3. **Rust is built from scratch** every deploy, even when the runner did not change.
4. **The build runs on the 4-vCPU production VM** while that VM serves Paperclip and runs agents.
5. **The disk is too small for this.** The 123 GB OS disk holds about 95 GB of Docker
   data: the image, the 34 GB `paperclip-data` volume, the build cache, and containerd
   snapshots. A build needs about 30 GB free.

## Target

CI builds the image once per deploy commit on a GitHub-hosted runner, with a persistent
layer cache, and pushes it to GHCR as `ghcr.io/wiredcio/paperclip:deploy-<sha>`. The VM only pulls the finished image and restarts.

- The deploy step on the VM takes about 2-3 minutes: pull, `up -d`, health check.
- No build cache or build scratch space on the VM. The disk only holds the running image
  plus one previous image for rollback.
- Rollback pulls the previous commit's image instead of rebuilding it, so it takes seconds.
- Builds run on dedicated runner capacity, not on production. The fork is public, so
  `ubuntu-latest` runners are 4 vCPU / 16 GB and free.

## Design

### 1. New `build-image` job in `wiredcio-deploy.yml`

It runs on `ubuntu-latest` for pushes to `wiredcio/deploy`, guarded by
`github.repository == 'WiredCIO/paperclip'` like the deploy job. Permissions are
`contents: read` and `packages: write`.

Steps:

- Checkout, then the same "free runner disk" step `docker.yml` already uses. The hosted
  runner has about 14 GB free by default, which is not enough for a 17 GB image.
- `docker/setup-buildx-action`, then a GHCR login with `GITHUB_TOKEN`.
- `docker/build-push-action`:
  - `target: cloud`, the same final stage compose builds today.
  - Build args `PAPERCLIP_BUILD_COMMIT=${{ github.sha }}` and
    `CLI_TOOLS_CACHE_EPOCH=<ISO week>`, copied from `docker.yml`.
  - Tag `ghcr.io/wiredcio/paperclip:deploy-<sha>`. The `deploy-` prefix keeps these tags apart from upstream image tags.
  - `cache-from` / `cache-to: type=registry,ref=ghcr.io/wiredcio/paperclip:deploy-buildcache,mode=max`.
    Use a registry cache, not `type=gha`: the GHA cache is capped at 10 GB per repo, and
    this build's cache is about 28 GB.
  - `provenance: false`, so the VM can pull a plain single-arch manifest.
- `timeout-minutes: 60`. The first build is cold. Later builds reuse the registry cache
  and should take about 8-12 minutes.

The GHCR package stays private. The image contains no secrets (runtime config comes from
`.env.prod`), but there is no reason to publish it.

### 2. The `deploy` job pulls instead of building

`deploy` gets `needs: build-image` and stays on `[self-hosted, wiredcio-deploy]`. It gets
`permissions: packages: read` and passes `GITHUB_TOKEN` and the image ref to the script:

```yaml
env:
  WIREDCIO_DEPLOY_IMAGE_REPO: ghcr.io/wiredcio/paperclip
  WIREDCIO_DEPLOY_TRIGGER_SHA: ${{ github.sha }}
  GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The job token is short-lived and scoped to this run, so no long-lived registry credential
is ever stored on the VM.

`concurrency: wiredcio-deploy` with `cancel-in-progress: false` stays. Builds for two
quick merges can overlap. Their deploys still run one at a time, in order.

### 3. `wiredcio-deploy.sh` changes

- The deploy commit's image is pulled with the run token in a throwaway
  `docker --config` directory. It is then retagged as the image compose already
  runs for `server` (`compose config --images server`, which is `docker-server`
  today), and the server starts with `compose up -d --no-build`.
- The `docker builder prune --keep-storage 10gb` step only runs on the build
  fallback path now.
- After a healthy start, the script keeps the running `deploy-` image and the one
  before it, and removes older ones. It never runs `docker system prune`, which
  would touch the `paperclip-data` volume.
- Rollback reuses or pulls `deploy-<before_sha>`. If CI never built that commit
  (the first rollback after the switch), it falls back to `compose build` on the VM.
- If the pull fails for the exact commit CI just built, the run fails without
  touching production. This is the same as a failed build today.
- If the branch has moved past this run's commit and the newer image isn't built
  yet, the script resets the checkout and exits 0. The newer commit's own run
  deploys it.
- The re-exec, the running-commit stamp and the health-check logic are unchanged.
  `/api/health` still reports the commit, because CI passes `PAPERCLIP_BUILD_COMMIT`.

### 4. VM-local compose file

No change needed. Retagging the pulled image under compose's own image name
means the untracked `docker/docker-compose.managed.yml` stays as it is, `build:`
block included, and the fallback still uses that block.

### 5. Clean up the VM once the switch is proven

After two successful pull-based deploys, run `docker builder prune -af` once. That frees
about 29 GB of build cache, and the VM never needs it again.

## Rollout

1. A PR into `wiredcio/deploy` with the workflow and script changes, plus updates to
   `doc/RELEASING-WIREDCIO.md` and `doc/DEVELOPING.md`. Its CI is the normal `ci / verify`.
   Merging it is the first real test: its own push runs `build-image`, then the new
   pull-based deploy.
2. Watch the first deploy end to end: build time, pull time, health, and `/api/health`
   commit. If it fails, the script's rollback uses the build fallback for the
   pre-switch commit.
3. Make a second small merge to confirm the warm-cache build time and the image pruning.
4. One-time `docker builder prune -af` on the VM (Russell).

## Separate but related

- **Grow the OS disk to 256 GB anyway.** Without builds on the VM, the 34 GB data volume
  and two images fit in 123 GB. But the data volume keeps growing, and today's margin
  is thin. This needs a VM stop/start and is an Azure change Russell makes.
- **Slim the production image.** Copying only `server/dist`, `ui/dist`, production
  `node_modules` and the runner artifacts, not all of `/app`, would cut the
  image size and the pull time. Upstream owns the `Dockerfile`, so do this upstream or
  carry it as a small deploy-branch patch. Only do it after the switch above, and as its own change.
- **Build on PR CI so the image is ready at merge.** Squash merges change the SHA, so this
  needs content-addressed tagging. Not needed if the warm build is about 10 minutes.

## Risks

- **First cold build in CI** may take 30-40 minutes. The 60-minute job limit covers it.
- **Hosted runner disk:** if freeing the disk is not enough for a 17 GB image, use a
  larger GitHub-hosted runner, or slim the image first.
- **GHCR outage:** deploys fail at the pull, before anything restarts, so production keeps
  running. The build fallback can still be used by hand.
- **Trust boundary:** the image is now built by GitHub-hosted runners from the pushed
  commit instead of on the VM from the same commit. The source and the ruleset gate
  (`ci / verify` before merge) are unchanged. The VM only pulls an image tagged with the
  exact commit that triggered the run.

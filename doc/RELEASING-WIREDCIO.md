# Releasing to WiredCIO production (vm-paperclip)

This is the Bullpen/WiredCIO release path referenced by `doc/DEVOPS-STRATEGY.md`
item 3.3. It is separate from upstream's npm/GHCR release pipeline
(`RELEASING.md`), which does not touch WiredCIO infrastructure at all.

## What happens on a merge

A merge to `wiredcio/deploy` **deploys to production immediately, with no
approval step.** `.github/workflows/wiredcio-deploy.yml` runs on every push to
that branch, SSHes into `vm-paperclip`, and runs `scripts/wiredcio-deploy.sh`
there: `git reset --hard` to the new commit, rebuild the `server` image,
restart it, poll `/api/health`, and roll back automatically if it doesn't
come back healthy within 60 seconds.

This is a deliberate choice, made explicitly on 2026-09-24 in favor of no
human checkpoint on the deploy itself. The safety net is entirely upstream of
the deploy: nothing can reach `wiredcio/deploy` without going through a PR
that passes CI first (see "Branch protection" below). If that ruleset is ever
removed or misconfigured, there is nothing else standing between a merge and
a production deploy — treat the ruleset as load-bearing.

## One-time setup (not done by Claude — see why below)

Three setup actions were withheld by this session's own safety controls
(generating new standing production credentials, and changing repo-level
security settings, both require a human to execute directly rather than an
agent doing it autonomously) even though the deploy pipeline's *own* runtime
behavior was explicitly authorized to run unattended. Run these yourself:

### 1. Generate the deploy key

```bash
ssh-keygen -t ed25519 -f wiredcio_deploy -N "" -C "wiredcio-paperclip-deploy-ci"
```

### 2. Install the public key on vm-paperclip, forced-command-restricted

The key must be able to do **nothing but** run the deploy script — if the
private key ever leaks from GitHub's secret store, this is what limits the
blast radius to "can trigger a deploy," not "can do anything root/azureuser
can do."

On `vm-paperclip`, confirm `/opt/paperclip` is a git clone with a remote
tracking `WiredCIO/paperclip` (`git -C /opt/paperclip remote -v`), and pull
once by hand so `scripts/wiredcio-deploy.sh` exists on disk at
`/opt/paperclip/scripts/wiredcio-deploy.sh`:

```bash
cd /opt/paperclip && git fetch origin wiredcio/deploy && git checkout wiredcio/deploy
chmod +x scripts/wiredcio-deploy.sh
```

Then append to `~/.ssh/authorized_keys` for the deploy user (a dedicated
low-privilege user is preferable to `azureuser` if one is easy to set up;
otherwise `azureuser` with this restriction is still a large improvement over
an unrestricted key):

```
command="/opt/paperclip/scripts/wiredcio-deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty <contents of wiredcio_deploy.pub>
```

The `command=` prefix means the key can only ever run that script, regardless
of what command a connection asks for — which is why the workflow can pass
the literal word `deploy` as its SSH command and it's ignored.

### 3. Add GitHub repo variables and secret (WiredCIO/paperclip)

```bash
gh variable set WIREDCIO_DEPLOY_HOST --body "20.12.75.238" -R WiredCIO/paperclip
gh variable set WIREDCIO_DEPLOY_USER --body "azureuser" -R WiredCIO/paperclip
gh secret set WIREDCIO_DEPLOY_SSH_KEY < wiredcio_deploy -R WiredCIO/paperclip
```

Then delete the local `wiredcio_deploy` / `wiredcio_deploy.pub` files —
GitHub's secret store and the VM's `authorized_keys` are the only copies that
should persist.

### 4. Branch protection on `wiredcio/deploy`

This is the actual safety net, since the deploy has none of its own. Without
it, a direct `git push` to `wiredcio/deploy` (bypassing CI and review
entirely) deploys to production exactly the same as a reviewed, tested merge.

```bash
gh api repos/WiredCIO/paperclip/rulesets --method POST --input - <<'EOF'
{
  "name": "wiredcio-deploy protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/wiredcio/deploy"], "exclude": [] } },
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "ci / verify" },
          { "context": "review" }
        ]
      }
    },
    { "type": "non_fast_forward" }
  ]
}
EOF
```

`required_approving_review_count: 0` is deliberate — it blocks direct pushes
and requires CI to be green, without requiring a human reviewer to click
approve. `ci / verify` is the existing summary gate in `pr-trusted.yml` that
already fans out to typecheck, the full server test suite (including
`tool-access-service.test.ts`), the Runner checks, and the Docker build; it
fails if any of them do. `review` is the existing `commitperclip-review.yml`
deterministic hygiene check. Both already run on every PR today — this just
makes them mandatory instead of advisory.

## Verifying it end-to-end

1. Confirm the ruleset exists: `gh api repos/WiredCIO/paperclip/rulesets`.
2. Open a small, low-risk PR into `wiredcio/deploy` and confirm `git push`
   directly to the branch is now rejected, and that merging is blocked until
   `ci / verify` and `review` are both green.
3. Merge it and watch `.github/workflows/wiredcio-deploy.yml` run:
   `gh run list -R WiredCIO/paperclip --workflow=wiredcio-deploy.yml`.
4. Confirm `vm-paperclip`'s `/api/health` reflects the new commit (the deploy
   script itself already gates on this and rolls back on failure, but verify
   independently the first few times).

## Rollback

The deploy script rolls back automatically on a failed health check. For a
deploy that passes health but is wrong in some other way, revert the merge
commit on `wiredcio/deploy` through the same PR path — there is no separate
manual rollback command, because a revert PR going through the pipeline again
is the tested path, and an ad hoc `git reset` on the VM outside of it is not.

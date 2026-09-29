# Releasing to WiredCIO production (vm-paperclip)

This is the Bullpen/WiredCIO release path referenced by `doc/DEVOPS-STRATEGY.md`
item 3.3. It is separate from upstream's npm/GHCR release pipeline
(`RELEASING.md`), which does not touch WiredCIO infrastructure at all.

## What happens on a merge

A merge to `wiredcio/deploy` **deploys to production immediately, with no
approval step.** `.github/workflows/wiredcio-deploy.yml` runs on every push to
that branch and executes `/opt/paperclip/scripts/wiredcio-deploy.sh` directly
on `vm-paperclip`: `git reset --hard` to the new commit, rebuild the `server`
image, restart it, poll `/api/health`, and roll back automatically if it
doesn't come back healthy within 60 seconds.

This is a deliberate choice, made explicitly on 2026-09-24 in favor of no
human checkpoint on the deploy itself. The safety net is entirely upstream of
the deploy: nothing can reach `wiredcio/deploy` without going through a PR
that passes `ci / verify` first (see "Branch protection" below). If that
ruleset is ever removed or misconfigured, there is nothing else standing
between a merge and a production deploy — treat the ruleset as load-bearing.

## Why this runs on a self-hosted runner, not GitHub-hosted

The first version of this pipeline used a GitHub-hosted runner that SSHed
into the VM. It never worked: `vm-paperclip`'s NSG only allows SSH from a
handful of known static IPs, and GitHub-hosted runners come from a pool of
7,000+ constantly-rotating CIDR ranges (verified against the `actions` list
in `https://api.github.com/meta` — even fully collapsed via CIDR aggregation
it's 5,478 ranges, still over Azure's 4,000-prefix-per-rule limit for the
IPv4 half alone). Widening the NSG to that whole range was considered and
rejected as too large a reduction in a security posture that had otherwise
stayed narrow and deliberate.

Instead, `vm-paperclip` runs a self-hosted GitHub Actions runner
(`~/actions-runner`, registered to `WiredCIO/paperclip` with the label
`wiredcio-deploy`, installed as the systemd service
`actions.runner.WiredCIO-paperclip.vm-paperclip.service` running as
`azureuser`). It polls GitHub over an outbound connection, so the NSG needed
zero changes — no inbound access to the VM is required at all. The deploy job
just runs `scripts/wiredcio-deploy.sh` locally, no SSH key, no secrets.

The tradeoff, and the reason the runner's *installation* was deliberately not
automated (this session's own safety controls declined to do it
autonomously, flagged explicitly as "creates an RCE surface"): anything able
to schedule a job against the `wiredcio-deploy` label can execute code on
this VM. That's a materially different trust boundary than "an SSH key
forced-command-restricted to one script" was, and it's the reason
`if: github.repository == 'WiredCIO/paperclip'` on the job is meaningful, not
decorative — a fork-of-a-fork or a malicious PR from an external contributor
must never be able to target this runner label.

## One-time setup already done (kept here for anyone rebuilding this)

1. Downloaded and registered the runner on `vm-paperclip`:
   ```bash
   mkdir -p ~/actions-runner && cd ~/actions-runner
   curl -o actions-runner-linux-x64-2.337.0.tar.gz -L \
     https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz
   tar xzf actions-runner-linux-x64-2.337.0.tar.gz
   ./config.sh --url https://github.com/WiredCIO/paperclip \
     --token <registration token from `gh api repos/WiredCIO/paperclip/actions/runners/registration-token --method POST`, expires in 1h> \
     --labels wiredcio-deploy --name vm-paperclip --work _work --unattended --replace
   ```
2. Installed it as a systemd service (the step withheld from Claude, run by
   Russell directly):
   ```bash
   cd ~/actions-runner && sudo ./svc.sh install azureuser && sudo ./svc.sh start
   ```
3. Branch protection on `wiredcio/deploy` (also withheld from Claude —
   changing repo security settings requires a human directly):
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
           "required_status_checks": [ { "context": "ci / verify" } ]
         }
       },
       { "type": "non_fast_forward" }
     ]
   }
   EOF
   ```
   `required_approving_review_count: 0` is deliberate — it blocks direct
   pushes and requires CI to be green, without requiring a human reviewer to
   click approve. `ci / verify` is the existing summary gate in
   `pr-trusted.yml` that fans out to typecheck, the full server test suite
   (including `tool-access-service.test.ts`), the Runner checks, the Docker
   build, and e2e; it fails if any of them do.

   `review` (the `commitperclip-review.yml` GitHub App hygiene check) was
   **deliberately left out** of the required checks: as of 2026-09-24 it
   fails on every PR with `401: A JSON web token could not be decoded` — the
   `wiredcio-bullpen-bot` GitHub App from `doc/DEVOPS-STRATEGY.md` §15.1 was
   never finished being set up. Requiring a permanently-broken check would
   have made `wiredcio/deploy` unmergeable. Revisit once that App identity
   actually works, and add `{ "context": "review" }` back to the
   `required_status_checks` list above.

## Ongoing VM housekeeping this pipeline depends on

- `/opt/paperclip` must stay owned by `azureuser` (the deploy script and the
  runner both operate as that user). It was previously a mix of `root` and
  `azureuser` ownership from earlier manual `sudo` operations, which broke
  `git reset --hard` outright (`Permission denied` on `.git/FETCH_HEAD` and
  various tracked files) — fixed once with
  `sudo chown -R azureuser:azureuser /opt/paperclip`, but any future `sudo`
  operation against that tree risks reintroducing it.
- Files added to this repo from a Windows checkout do not preserve the Unix
  executable bit — `scripts/wiredcio-deploy.sh` shipped non-executable in its
  first commit and had to be fixed with `git update-index --chmod=+x`, which
  is the only way to fix it durably (a one-off `chmod` on the VM gets
  reverted by the next `git reset --hard`).
- This checkout names the WiredCIO fork remote `fork`, not `origin` —
  `origin` points at upstream `paperclipai/paperclip`. The deploy script
  resolves the branch's actual `@{u}` tracking ref rather than assuming a
  remote name, specifically because of this.

## Verifying it end-to-end

1. Confirm the ruleset exists: `gh api repos/WiredCIO/paperclip/rulesets`.
2. Confirm the runner is online: `gh api repos/WiredCIO/paperclip/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'`.
3. Open a small, low-risk PR into `wiredcio/deploy` and confirm `git push`
   directly to the branch is rejected, and that merging is blocked until
   `ci / verify` is green.
4. Merge it and watch `.github/workflows/wiredcio-deploy.yml` run:
   `gh run list -R WiredCIO/paperclip --workflow=wiredcio-deploy.yml`.
5. Confirm `vm-paperclip`'s `/api/health` reflects the new commit (the deploy
   script itself already gates on this and rolls back on failure, but verify
   independently the first few times).

## Rollback

The deploy script rolls back automatically on a failed health check. For a
deploy that passes health but is wrong in some other way, revert the merge
commit on `wiredcio/deploy` through the same PR path — there is no separate
manual rollback command, because a revert PR going through the pipeline again
is the tested path, and an ad hoc `git reset` on the VM outside of it is not.

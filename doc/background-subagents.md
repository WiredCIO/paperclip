# Background subagents: contract and status reporting

An agent adapter (Claude Code and similar CLI-driven adapters) can spawn its own subagents. Some
of those subagents may still be running when the parent process returns its terminal result —
for example, because the parent chose to run one in the background instead of waiting on it.

## The contract: background subagents are not durable

**Paperclip does not keep a run's process alive to wait on a background subagent, and it does not
resume it on a later heartbeat.** Once the parent adapter process reports a terminal result,
Paperclip's `terminal_result_cleanup` path (`packages/adapter-utils/src/server-utils.ts`) arms a
grace timer and then signals the whole process group (`SIGTERM`, escalating to `SIGKILL`) to
reclaim it. Any subagent still running at that point is killed with it. There is no notification
path back to the agent, and no separate execution lane a background subagent can continue on.

This means:

- Whatever the background subagent had not yet done — posting a review, finishing an analysis,
  writing a file — is lost. It will not complete, and nothing retries it.
- An agent that spawns "fire and forget" background work and returns is *reporting a run as done
  before its own stated work is actually finished*. Adapter instructions should treat anything
  that must survive past the run's own terminal result as work to do synchronously, not as
  background work with an implied follow-up.
- If a workflow genuinely needs multi-stage async work (e.g. "wait for CI, then post a review"),
  it needs a durable mechanism outside the run process — a scheduled wakeup, a monitor, or a
  follow-up issue/interaction — not an in-process background task.

This was picked deliberately as the simplest of three options (unsupported-and-rejected,
kept-alive-until-finished, or silently-reaped): keeping a run's process alive indefinitely for an
unbounded background task is not something the runtime can size or bound safely, and rejecting
background subagents outright would require adapter-side enforcement Paperclip cannot verify.
Reaping is therefore the contract — but see below for why it must not read as an adapter failure.

## Status reporting: a reaped background task is not an adapter failure

Before WIR-192, a run whose CLI transcript reported a clean success (`is_error: false`,
`subtype: "success"`) but whose process was signal-killed to reap an orphaned background subagent
was classified as `adapter_failed`. That conflated two different things: whether the *run's own
work* completed, and whether *cleanup of something the run left behind* was clean.

The rule going forward:

- A run's `outcome` (`succeeded` vs `failed`) is driven by what the adapter itself reported before
  cleanup — `is_error`, `subtype`, and any error message/code — not by the exit signal used to
  reclaim an orphaned background subagent. See `resolveProcessAdapterRunOutcome` in
  `server/src/services/heartbeat.ts`.
- If the adapter itself reported failure (an error message or error code), a reaped background
  task on top of that does **not** rescue the run into `succeeded`. Both things going wrong is
  still a failure.
- The evidence is not deleted. `resultJson.unmanagedBackgroundTask` (`stopped`, `signal`,
  `terminalResultSeen`, `forceKilled`) and `resultJson.subagent_stats.by_type` are both preserved
  on the run, and the run detail UI (`ui/src/components/IssueRunLedger.tsx`) surfaces a
  "Background subagent reaped: `<type>`" badge so the cause is visible without reading raw JSON.

## This applies going forward only

This reclassification is not backfilled onto historical runs. A run recorded as `adapter_failed`
before this change stays recorded that way; only runs finalized after this change benefit from
the corrected classification.

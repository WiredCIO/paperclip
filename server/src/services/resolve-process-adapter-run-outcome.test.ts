import { describe, expect, it } from "vitest";
import { resolveProcessAdapterRunOutcome } from "./heartbeat.js";

// Fixture shaped like the adapter result JSON captured in WIR-192: a Claude
// Code CLI invocation that completed successfully, but had a background
// subagent (hostile-reviewer) still running when the parent returned its
// terminal result, so terminal_result_cleanup reaped it with SIGTERM.
const REAPED_BACKGROUND_SUBAGENT_RESULT_JSON = {
  is_error: false,
  subtype: "success",
  stop_reason: "end_turn",
  terminal_reason: "completed",
  subagent_stats: {
    spawned: 1,
    completed: 0,
    started_in_background: 1,
    by_type: { "hostile-reviewer": 1 },
    requested: { unset: 1, background: 0, foreground: 0 },
  },
  unmanagedBackgroundTask: {
    kind: "terminal_result_cleanup",
    reason: "unmanaged background task stopped; no durable live path",
    signal: "SIGTERM",
    stopped: true,
    forceKilled: false,
    terminalResultSeen: true,
    stopReason: "unmanaged_background_task_stopped",
  },
};

describe("resolveProcessAdapterRunOutcome", () => {
  it("treats a successful run with a reaped background subagent as succeeded, not adapter_failed", () => {
    const outcome = resolveProcessAdapterRunOutcome({
      exitCode: null,
      errorMessage: null,
      errorCode: null,
      signal: "SIGTERM",
      resultJson: REAPED_BACKGROUND_SUBAGENT_RESULT_JSON,
      cancellationFailed: false,
    });

    expect(outcome).toBe("succeeded");
  });

  it("still fails a signal-killed run when the adapter reported an actual error", () => {
    const outcome = resolveProcessAdapterRunOutcome({
      exitCode: null,
      errorMessage: "Claude exited with code 1",
      errorCode: "claude_transient_upstream",
      signal: "SIGTERM",
      resultJson: {
        is_error: true,
        subtype: "error",
        unmanagedBackgroundTask: REAPED_BACKGROUND_SUBAGENT_RESULT_JSON.unmanagedBackgroundTask,
      },
      cancellationFailed: false,
    });

    expect(outcome).toBe("failed");
  });

  it("still fails a signal-killed run with no reaped-background-task evidence", () => {
    const outcome = resolveProcessAdapterRunOutcome({
      exitCode: null,
      errorMessage: null,
      errorCode: null,
      signal: "SIGKILL",
      resultJson: { is_error: false, subtype: "success" },
      cancellationFailed: false,
    });

    expect(outcome).toBe("failed");
  });

  it("succeeds a clean exit with no signal and no error", () => {
    const outcome = resolveProcessAdapterRunOutcome({
      exitCode: 0,
      errorMessage: null,
      errorCode: null,
      signal: null,
      resultJson: { is_error: false, subtype: "success" },
      cancellationFailed: false,
    });

    expect(outcome).toBe("succeeded");
  });

  it("fails a non-zero exit with reap evidence but no signal (evidence alone is not enough)", () => {
    const outcome = resolveProcessAdapterRunOutcome({
      exitCode: 1,
      errorMessage: null,
      errorCode: null,
      signal: null,
      resultJson: REAPED_BACKGROUND_SUBAGENT_RESULT_JSON,
      cancellationFailed: false,
    });

    expect(outcome).toBe("failed");
  });

  it("fails a run that was cancelled mid-cleanup even with reaped-task evidence", () => {
    const outcome = resolveProcessAdapterRunOutcome({
      exitCode: null,
      errorMessage: null,
      errorCode: null,
      signal: "SIGTERM",
      resultJson: REAPED_BACKGROUND_SUBAGENT_RESULT_JSON,
      cancellationFailed: true,
    });

    expect(outcome).toBe("failed");
  });
});

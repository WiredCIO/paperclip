import { desc, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/**
 * Wake sources that are safe to drop while an agent's provider allowance is
 * exhausted. Timers and routines fire again on their own schedule, so skipping
 * one loses nothing. Assignment and on-demand wakes are never held: they carry
 * a specific request and must be recorded as normal failures or retried by the
 * recovery service.
 */
export const PROVIDER_QUOTA_HOLD_SOURCES: ReadonlySet<string> = new Set(["timer", "automation"]);

const QUOTA_ERROR_CODES = new Set(["provider_quota", "claude_transient_upstream"]);

// Claude CLI wording when a seat's five-hour, weekly or extra-usage allowance
// is gone. "org's monthly spend limit" is what a rejected five-hour window
// prints when overage is disabled at the org level, so it must count as quota.
const QUOTA_ERROR_RE =
  /(?:spend\s+limit|usage\s+(?:limit|cap)|hit\s+your\s+(?:[\w'’]+\s+){0,3}limit|(?:5[-\s]?hour|weekly|session)\s+limit|out\s+of\s+extra\s+usage)/i;

const BASE_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 2 * 60 * 60_000;
// A provider-reported reset is trusted, but never beyond this, so a bad
// timestamp cannot park an agent for days.
const MAX_REPORTED_RESET_MS = 6 * 60 * 60_000;
const LOOKBACK_RUNS = 6;
const FINISHED_STATUSES: ReadonlySet<string> = new Set(["failed", "succeeded", "timed_out"]);

export interface QuotaHoldRunRow {
  status: string;
  errorCode: string | null;
  error: string | null;
  finishedAt: Date | null;
  resultJson: unknown;
}

export interface ProviderQuotaHold {
  until: Date;
  consecutiveFailures: number;
  reason: string;
}

export function isProviderQuotaFailure(run: QuotaHoldRunRow): boolean {
  if (run.status !== "failed") return false;
  if (!run.errorCode || !QUOTA_ERROR_CODES.has(run.errorCode)) return false;
  return run.errorCode === "provider_quota" || QUOTA_ERROR_RE.test(run.error ?? "");
}

function readReportedRetryAt(resultJson: unknown): Date | null {
  if (typeof resultJson !== "object" || resultJson === null) return null;
  const record = resultJson as Record<string, unknown>;
  const raw = record.providerQuotaRetryNotBefore ?? record.retryNotBefore;
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `recentRuns` is newest-first and contains finished runs only. The hold lasts
 * while the leading streak of runs are quota failures; a success or any other
 * failure ends it. Each further failure doubles the wait, which also makes the
 * first run after a hold lapses a single cheap probe.
 */
export function evaluateProviderQuotaHold(
  recentRuns: readonly QuotaHoldRunRow[],
  now: Date,
): ProviderQuotaHold | null {
  let streak = 0;
  for (const run of recentRuns) {
    if (!isProviderQuotaFailure(run)) break;
    streak += 1;
  }
  if (streak === 0) return null;

  const latest = recentRuns[0]!;
  if (!latest.finishedAt) return null;
  const finishedMs = latest.finishedAt.getTime();

  const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** (streak - 1), MAX_BACKOFF_MS);
  let untilMs = finishedMs + backoffMs;

  const reported = readReportedRetryAt(latest.resultJson);
  if (reported && reported.getTime() > finishedMs) {
    untilMs = Math.max(untilMs, Math.min(reported.getTime(), finishedMs + MAX_REPORTED_RESET_MS));
  }

  if (untilMs <= now.getTime()) return null;
  return {
    until: new Date(untilMs),
    consecutiveFailures: streak,
    reason: latest.error ?? "provider quota exhausted",
  };
}

export async function getProviderQuotaHold(
  db: Db,
  agentId: string,
  now: Date = new Date(),
): Promise<ProviderQuotaHold | null> {
  const rows = await db
    .select({
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      error: heartbeatRuns.error,
      finishedAt: heartbeatRuns.finishedAt,
      resultJson: heartbeatRuns.resultJson,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.agentId, agentId))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(LOOKBACK_RUNS * 4);
  // Cancelled and in-flight runs say nothing about the allowance.
  const finished = rows
    .filter((row) => row.finishedAt !== null && FINISHED_STATUSES.has(row.status))
    .slice(0, LOOKBACK_RUNS);
  return evaluateProviderQuotaHold(finished, now);
}

import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_HOLD_SOURCES,
  evaluateProviderQuotaHold,
  isProviderQuotaFailure,
  type QuotaHoldRunRow,
} from "../services/provider-quota-hold.js";

const NOW = new Date("2026-10-19T13:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

function quotaFailure(finishedMinutesAgo: number, resultJson: unknown = null): QuotaHoldRunRow {
  return {
    status: "failed",
    errorCode: "claude_transient_upstream",
    error: "Claude run failed: subtype=success: You've hit your org's monthly spend limit",
    finishedAt: minutesAgo(finishedMinutesAgo),
    resultJson,
  };
}

const success = (finishedMinutesAgo: number): QuotaHoldRunRow => ({
  status: "succeeded",
  errorCode: null,
  error: null,
  finishedAt: minutesAgo(finishedMinutesAgo),
  resultJson: null,
});

describe("provider quota hold", () => {
  it("only holds scheduled wake sources", () => {
    expect([...PROVIDER_QUOTA_HOLD_SOURCES].sort()).toEqual(["automation", "timer"]);
  });

  it("recognises quota failures and ignores ordinary transient ones", () => {
    expect(isProviderQuotaFailure(quotaFailure(1))).toBe(true);
    expect(
      isProviderQuotaFailure({ ...quotaFailure(1), errorCode: "claude_transient_upstream", error: "API Error: 529 overloaded" }),
    ).toBe(false);
    expect(isProviderQuotaFailure({ ...quotaFailure(1), errorCode: "provider_quota", error: null })).toBe(true);
    expect(isProviderQuotaFailure({ ...quotaFailure(1), status: "cancelled" })).toBe(false);
  });

  it("holds for the base backoff after a first failure", () => {
    const hold = evaluateProviderQuotaHold([quotaFailure(5)], NOW);
    expect(hold?.consecutiveFailures).toBe(1);
    expect(hold?.until.toISOString()).toBe(minutesAgo(5 - 15).toISOString());
  });

  it("doubles the wait for each further failure and caps it", () => {
    const three = evaluateProviderQuotaHold([quotaFailure(1), quotaFailure(20), quotaFailure(40)], NOW);
    expect(three?.consecutiveFailures).toBe(3);
    expect(three?.until.getTime()).toBe(minutesAgo(1).getTime() + 60 * 60_000);

    const many = evaluateProviderQuotaHold(Array.from({ length: 6 }, (_, i) => quotaFailure(1 + i)), NOW);
    expect(many?.until.getTime()).toBe(minutesAgo(1).getTime() + 2 * 60 * 60_000);
  });

  it("lapses once the backoff has elapsed so one probe run can go through", () => {
    expect(evaluateProviderQuotaHold([quotaFailure(16)], NOW)).toBeNull();
  });

  it("ends the hold on any success", () => {
    expect(evaluateProviderQuotaHold([success(1), quotaFailure(10)], NOW)).toBeNull();
  });

  it("honours a provider-reported reset but caps it at six hours", () => {
    const reported = new Date(NOW.getTime() + 3 * 60 * 60_000).toISOString();
    const hold = evaluateProviderQuotaHold([quotaFailure(1, { retryNotBefore: reported })], NOW);
    expect(hold?.until.toISOString()).toBe(reported);

    const absurd = new Date(NOW.getTime() + 72 * 60 * 60_000).toISOString();
    const capped = evaluateProviderQuotaHold([quotaFailure(1, { retryNotBefore: absurd })], NOW);
    expect(capped?.until.getTime()).toBe(minutesAgo(1).getTime() + 6 * 60 * 60_000);
  });

  it("returns null when there is no history", () => {
    expect(evaluateProviderQuotaHold([], NOW)).toBeNull();
  });
});

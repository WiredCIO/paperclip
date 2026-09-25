import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_RUNTIME_LIMITS,
  readLegacyAdapterMaxTurns,
  resolveAgentRuntimeLimits,
} from "./agent-runtime-limits.js";

describe("readLegacyAdapterMaxTurns", () => {
  it("reads a positive cap", () => {
    expect(readLegacyAdapterMaxTurns({ maxTurns: 80 })).toEqual({
      present: true,
      maxTurnsPerRun: 80,
    });
  });

  it("treats a legacy 0 as present-and-uncapped, not absent", () => {
    // The distinction matters: absent should get the new default, while an
    // explicit 0 was an opt-out and must not silently gain a cap.
    expect(readLegacyAdapterMaxTurns({ maxTurns: 0 })).toEqual({
      present: true,
      maxTurnsPerRun: null,
    });
  });

  it("reads claude_local's maxTurnsPerRun spelling too", () => {
    // claude_local stored the legacy cap under a different key; missing it
    // would silently re-cap those agents at the new default.
    expect(readLegacyAdapterMaxTurns({ maxTurnsPerRun: 1000 })).toEqual({
      present: true,
      maxTurnsPerRun: 1000,
    });
  });

  it("prefers maxTurns when an adapter config somehow carries both", () => {
    expect(readLegacyAdapterMaxTurns({ maxTurns: 80, maxTurnsPerRun: 1000 })).toEqual({
      present: true,
      maxTurnsPerRun: 80,
    });
  });

  it("treats a missing or non-numeric value as absent", () => {
    expect(readLegacyAdapterMaxTurns({})).toEqual({ present: false, maxTurnsPerRun: null });
    expect(readLegacyAdapterMaxTurns({ maxTurns: "80" })).toEqual({
      present: false,
      maxTurnsPerRun: null,
    });
    expect(readLegacyAdapterMaxTurns(null)).toEqual({ present: false, maxTurnsPerRun: null });
    expect(readLegacyAdapterMaxTurns([])).toEqual({ present: false, maxTurnsPerRun: null });
  });
});

describe("resolveAgentRuntimeLimits", () => {
  it("gives an unconfigured agent a bounded run", () => {
    expect(resolveAgentRuntimeLimits({})).toEqual({
      maxTurnsPerRun: 40,
      runTimeoutSec: 1800,
      mcpToolTimeoutSec: 120,
    });
    expect(DEFAULT_AGENT_RUNTIME_LIMITS.maxTurnsPerRun).toBe(40);
  });

  it("honours an agent's own limits", () => {
    expect(
      resolveAgentRuntimeLimits({
        agent: { maxTurnsPerRun: 80, runTimeoutSec: 600, mcpToolTimeoutSec: 45 },
      }),
    ).toEqual({ maxTurnsPerRun: 80, runTimeoutSec: 600, mcpToolTimeoutSec: 45 });
  });

  it("falls back to the company default for each key independently", () => {
    expect(
      resolveAgentRuntimeLimits({
        agent: { maxTurnsPerRun: 80 },
        company: { maxTurnsPerRun: 10, runTimeoutSec: 900 },
      }),
    ).toEqual({ maxTurnsPerRun: 80, runTimeoutSec: 900, mcpToolTimeoutSec: 120 });
  });

  it("removes only the turn cap for unlimited, keeping the run bounded in time", () => {
    const resolved = resolveAgentRuntimeLimits({ agent: { unlimited: true } });
    expect(resolved.maxTurnsPerRun).toBeNull();
    expect(resolved.runTimeoutSec).toBe(1800);
    expect(resolved.mcpToolTimeoutSec).toBe(120);
  });

  it("lets unlimited win over a number set beside it", () => {
    expect(
      resolveAgentRuntimeLimits({ agent: { unlimited: true, maxTurnsPerRun: 80 } }).maxTurnsPerRun,
    ).toBeNull();
  });

  it("supports an unlimited company default", () => {
    expect(resolveAgentRuntimeLimits({ company: { unlimited: true } }).maxTurnsPerRun).toBeNull();
  });

  it("honours a legacy adapterConfig.maxTurns when no limits are set", () => {
    expect(
      resolveAgentRuntimeLimits({ adapterConfig: { maxTurns: 80 } }).maxTurnsPerRun,
    ).toBe(80);
  });

  it("keeps a legacy 0 uncapped rather than imposing the new default", () => {
    expect(
      resolveAgentRuntimeLimits({ adapterConfig: { maxTurns: 0 } }).maxTurnsPerRun,
    ).toBeNull();
  });

  it("lets explicit agent limits win over a legacy value", () => {
    expect(
      resolveAgentRuntimeLimits({
        agent: { maxTurnsPerRun: 25 },
        adapterConfig: { maxTurns: 80 },
      }).maxTurnsPerRun,
    ).toBe(25);
  });

  it("lets a legacy per-agent value win over a company default", () => {
    expect(
      resolveAgentRuntimeLimits({
        company: { maxTurnsPerRun: 10 },
        adapterConfig: { maxTurns: 80 },
      }).maxTurnsPerRun,
    ).toBe(80);
  });

  it("ignores zero and negative values in the typed limits", () => {
    // 0 is the old uncapped spelling; in the typed block it is simply invalid,
    // and must not be mistaken for an opt-out.
    expect(
      resolveAgentRuntimeLimits({ agent: { maxTurnsPerRun: 0, runTimeoutSec: -5 } }),
    ).toEqual({ maxTurnsPerRun: 40, runTimeoutSec: 1800, mcpToolTimeoutSec: 120 });
  });

  it("truncates a fractional value rather than passing it to a CLI flag", () => {
    expect(resolveAgentRuntimeLimits({ agent: { maxTurnsPerRun: 40.9 } }).maxTurnsPerRun).toBe(40);
  });

  it("treats null the same as absent", () => {
    expect(
      resolveAgentRuntimeLimits({ agent: { maxTurnsPerRun: null }, company: null }).maxTurnsPerRun,
    ).toBe(40);
  });
});

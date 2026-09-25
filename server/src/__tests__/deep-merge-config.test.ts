import { describe, expect, it } from "vitest";
import { deepMergeConfig } from "../services/deep-merge-config.js";

describe("deepMergeConfig", () => {
  it("leaves untouched keys intact, which is the S4Water incident", () => {
    const existing = {
      heartbeat: { enabled: true, intervalSec: 300 },
      limits: { maxTurnsPerRun: 40 },
    };
    expect(deepMergeConfig(existing, { limits: { maxTurnsPerRun: 80 } })).toEqual({
      heartbeat: { enabled: true, intervalSec: 300 },
      limits: { maxTurnsPerRun: 80 },
    });
  });

  it("merges nested objects key by key rather than replacing them", () => {
    expect(
      deepMergeConfig(
        { limits: { maxTurnsPerRun: 40, runTimeoutSec: 1800 } },
        { limits: { runTimeoutSec: 600 } },
      ),
    ).toEqual({ limits: { maxTurnsPerRun: 40, runTimeoutSec: 600 } });
  });

  it("deletes a key on explicit null, which is how aiConnection is cleared", () => {
    expect(
      deepMergeConfig({ aiConnection: { provider: "anthropic" }, debug: true }, {
        aiConnection: null,
      }),
    ).toEqual({ debug: true });
  });

  it("deletes a nested key on null without disturbing its siblings", () => {
    expect(
      deepMergeConfig(
        { limits: { maxTurnsPerRun: 40, runTimeoutSec: 1800 } },
        { limits: { runTimeoutSec: null } },
      ),
    ).toEqual({ limits: { maxTurnsPerRun: 40 } });
  });

  it("replaces arrays wholesale instead of merging them element-wise", () => {
    expect(deepMergeConfig({ tags: ["a", "b", "c"] }, { tags: ["z"] })).toEqual({ tags: ["z"] });
  });

  it("replaces a scalar with an object and an object with a scalar", () => {
    expect(deepMergeConfig({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
    expect(deepMergeConfig({ a: { b: 2 } }, { a: 1 })).toEqual({ a: 1 });
  });

  it("handles absent base and patch", () => {
    expect(deepMergeConfig(null, { a: 1 })).toEqual({ a: 1 });
    expect(deepMergeConfig({ a: 1 }, null)).toEqual({ a: 1 });
    expect(deepMergeConfig(undefined, undefined)).toEqual({});
  });

  it("does not mutate either input", () => {
    const base = { limits: { maxTurnsPerRun: 40 } };
    const patch = { limits: { runTimeoutSec: 600 } };
    const merged = deepMergeConfig(base, patch);
    expect(base).toEqual({ limits: { maxTurnsPerRun: 40 } });
    expect(patch).toEqual({ limits: { runTimeoutSec: 600 } });
    expect(merged).not.toBe(base);
  });

  it("refuses prototype-polluting keys", () => {
    const merged = deepMergeConfig({ a: 1 }, JSON.parse('{"__proto__": {"polluted": true}}'));
    expect((merged as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(merged).toEqual({ a: 1 });
  });

  it("keeps a false or zero value rather than treating it as absent", () => {
    expect(deepMergeConfig({ debug: true, count: 5 }, { debug: false, count: 0 })).toEqual({
      debug: false,
      count: 0,
    });
  });
});

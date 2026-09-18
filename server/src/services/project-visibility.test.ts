import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateProjectVisibilityMemo, projectAccessMode } from "./project-visibility.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("projectAccessMode", () => {
  it("returns off when unset", () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", undefined);
    expect(projectAccessMode()).toBe("off");
  });

  it("returns off for an unrecognized value", () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "bogus");
    expect(projectAccessMode()).toBe("off");
  });

  it.each([
    ["shadow", "shadow"],
    ["SHADOW", "shadow"],
    ["Shadow", "shadow"],
    ["enforce", "enforce"],
    ["ENFORCE", "enforce"],
    ["Enforce", "enforce"],
    ["off", "off"],
    ["OFF", "off"],
  ] as const)("parses %s case-insensitively as %s", (raw, expected) => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", raw);
    expect(projectAccessMode()).toBe(expected);
  });
});

describe("getOrCreateProjectVisibilityMemo", () => {
  it("memoizes concurrent calls for the same key", async () => {
    const actor = {};
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve(calls);
    };

    const [a, b] = await Promise.all([
      getOrCreateProjectVisibilityMemo(actor, "company-1:project-1", load),
      getOrCreateProjectVisibilityMemo(actor, "company-1:project-1", load),
    ]);

    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  it("does not share memo entries across keys", async () => {
    const actor = {};
    const a = await getOrCreateProjectVisibilityMemo(actor, "key-a", () => Promise.resolve("a"));
    const b = await getOrCreateProjectVisibilityMemo(actor, "key-b", () => Promise.resolve("b"));
    expect(a).toBe("a");
    expect(b).toBe("b");
  });

  it("evicts a rejected entry so a retry can succeed", async () => {
    const actor = {};
    let attempt = 0;
    const load = () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("recovered");
    };

    await expect(getOrCreateProjectVisibilityMemo(actor, "key", load)).rejects.toThrow("boom");
    await expect(getOrCreateProjectVisibilityMemo(actor, "key", load)).resolves.toBe("recovered");
  });
});

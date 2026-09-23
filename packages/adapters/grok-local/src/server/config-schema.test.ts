import { describe, expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";
import { DEFAULT_GROK_LOCAL_MODEL } from "../index.js";

function field(key: string) {
  return getConfigSchema().fields.find((entry) => entry.key === key);
}

describe("grok_local config schema", () => {
  it("surfaces the run bounds, so they are reachable without hand-editing adapterConfig", () => {
    expect(field("maxTurns")).toBeDefined();
    expect(field("timeoutSec")).toBeDefined();
    expect(field("maxTurns")?.type).toBe("number");
    expect(field("timeoutSec")?.type).toBe("number");
  });

  it("says plainly that an unset bound means unbounded", () => {
    expect(field("maxTurns")?.hint).toMatch(/uncapped/i);
    expect(field("timeoutSec")?.hint).toMatch(/no timeout/i);
  });

  it("defaults web search to on", () => {
    expect(field("disableWebSearch")?.default).toBe(false);
  });

  it("keeps unattended tool approval on and leaves permissionMode empty", () => {
    expect(field("alwaysApprove")?.default).toBe(true);
    expect(field("permissionMode")?.default).toBe("");
  });

  it("defaults the model to the adapter's own default", () => {
    expect(field("model")?.default).toBe(DEFAULT_GROK_LOCAL_MODEL);
  });

  it("declares a unique key and a label for every field", () => {
    const fields = getConfigSchema().fields;
    const keys = fields.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of fields) expect(entry.label.length).toBeGreaterThan(0);
  });
});

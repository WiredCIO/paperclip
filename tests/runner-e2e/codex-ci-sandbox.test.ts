import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runnerMatrix } from "./catalog.js";
import { requiresCodexCiSandbox } from "./codex-ci-sandbox.js";

const root = path.resolve(import.meta.dirname, "../..");

describe("Codex CI sandbox trust boundary", () => {
  it.each([
    ["everyday-workflows.runner-codex.local.build-revise", true],
    ["everyday-workflows.runner-codex-mini.local.build-revise", true],
    ["everyday-workflows.runner-acpx-claude.local.build-revise", false],
    ["everyday-workflows.runner-codex.daytona.build-revise", false],
    ["core-compatibility.legacy-codex.local.message-marker", false],
  ] as const)("qualifies the native local Codex sandbox for %s: %s", (id, expected) => {
    const execution = runnerMatrix.find((cell) => cell.id === id);
    expect(execution, id).toBeDefined();
    expect(requiresCodexCiSandbox(execution!)).toBe(expected);
  });

  it("keeps privileged policy changes out of target-controlled tests", async () => {
    const source = await readFile(
      path.join(root, "tests/runner-e2e/codex-ci-sandbox.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /execFileSync\(["']sudo|apparmor_parser|flags=\(unconfined\)/,
    );
    expect(source).toMatch(/"sandbox",\s*"--permission-profile",\s*"paperclip-e2e-probe"/);
    expect(source).toContain(
      "permissions.paperclip-e2e-probe.network.enabled=false",
    );
    expect(source).toContain(
      'permissions.paperclip-e2e-probe.filesystem={":root"="read"}',
    );
    expect(source).toContain("Codex sandbox preflight failed");
    expect(source).not.toContain("...process.env");
  });

  it("provisions the exact executable in trusted CI before provider credentials", async () => {
    const workflow = await readFile(
      path.join(root, ".github/workflows/runner-full-stack-e2e.yml"),
      "utf8",
    );
    const setup = workflow.indexOf(
      "- name: Provision Codex sandbox on the disposable trusted runner",
    );
    const paid = workflow.indexOf("- name: Run paid cell");
    expect(setup).toBeGreaterThan(
      workflow.indexOf(
        "- name: Reauthorize paid execution before provider access",
      ),
    );
    expect(paid).toBeGreaterThan(setup);
    const step = workflow.slice(setup, paid);
    expect(step).toContain("matrix.profileId == 'runner-codex-mini'");
    expect(step).toContain('binary.startsWith(root + "/node_modules/.pnpm/")');
    expect(step).toContain("binary.endsWith(suffix)");
    expect(step).toContain('"-n", "apparmor_parser", "-r", profilePath');
    expect(step).toContain('flag:"wx"');
    expect(step).not.toContain("secrets.");
    expect(step).not.toContain("node scripts/");
    expect(step).not.toContain("sysctl -w");
  });
});

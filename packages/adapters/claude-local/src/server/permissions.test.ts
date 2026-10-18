import { describe, expect, it } from "vitest";
import { buildClaudeExecutionPermissionArgs, buildClaudeProbePermissionArgs, claudeSandboxPermissionEnv } from "./permissions.js";

describe("Claude full-auto permission args", () => {
  for (const [name, build] of [["execution", buildClaudeExecutionPermissionArgs], ["probe", buildClaudeProbePermissionArgs]] as const) {
    it.each([
      { targetIsRemote: false, localProcessUid: 1000 },
      { targetIsRemote: true, localProcessUid: 1000 },
      { targetIsRemote: false, localProcessUid: 0 },
      { targetIsRemote: true, localProcessUid: 0 },
    ])(`${name} requests full bypass for %j`, (target) => {
      expect(build({ ...target, dangerouslySkipPermissions: true }))
        .toEqual(["--dangerously-skip-permissions"]);
      expect(build({ ...target, dangerouslySkipPermissions: false })).toEqual([]);
    });
  }

<<<<<<< ours
    expect(allowedTools.split(" ")).toContain("Bash");
    expect(allowedTools).not.toContain("Bash(*)");
  });

  it("allows every tool of each runtime MCP server, or connected tools are listed but refused", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: true,
        mcpServerNames: ["paperclip-supabase-0ad0f4e4", "paperclip-supabase-efefe975"],
      }),
    ).toEqual([
      "--allowedTools",
      `${SANDBOX_ALLOWED_TOOLS} mcp__paperclip-supabase-0ad0f4e4 mcp__paperclip-supabase-efefe975`,
    ]);
  });

  it("does not pass permission flags when skip-permissions is disabled", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
  });

  it("uses dangerously-skip-permissions for non-root local execution", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("uses dangerously-skip-permissions for non-root local probes", () => {
    expect(
      buildClaudeProbePermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("uses allowedTools for local root execution because Claude refuses dangerously-skip-permissions as root", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 0,
      }),
    ).toEqual(["--allowedTools", SANDBOX_ALLOWED_TOOLS]);
  });

  it("uses allowedTools for local root probes because Claude refuses dangerously-skip-permissions as root", () => {
    expect(
      buildClaudeProbePermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 0,
      }),
    ).toEqual(["--allowedTools", SANDBOX_ALLOWED_TOOLS]);
||||||| base
    expect(allowedTools.split(" ")).toContain("Bash");
    expect(allowedTools).not.toContain("Bash(*)");
  });

  it("does not pass permission flags when skip-permissions is disabled", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
  });

  it("uses dangerously-skip-permissions for non-root local execution", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("uses dangerously-skip-permissions for non-root local probes", () => {
    expect(
      buildClaudeProbePermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("uses allowedTools for local root execution because Claude refuses dangerously-skip-permissions as root", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 0,
      }),
    ).toEqual(["--allowedTools", SANDBOX_ALLOWED_TOOLS]);
  });

  it("uses allowedTools for local root probes because Claude refuses dangerously-skip-permissions as root", () => {
    expect(
      buildClaudeProbePermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 0,
      }),
    ).toEqual(["--allowedTools", SANDBOX_ALLOWED_TOOLS]);
=======
  it("identifies managed sandboxes for Claude's root launch check only when full auto is enabled", () => {
    expect(claudeSandboxPermissionEnv({ dangerouslySkipPermissions: true, targetIsSandbox: true })).toEqual({ IS_SANDBOX: "1" });
    expect(claudeSandboxPermissionEnv({ dangerouslySkipPermissions: false, targetIsSandbox: true })).toEqual({});
    expect(claudeSandboxPermissionEnv({ dangerouslySkipPermissions: true, targetIsSandbox: false })).toEqual({});
>>>>>>> theirs
  });
});

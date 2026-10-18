interface ClaudePermissionInput {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
  localProcessUid?: number | null;
}

// Permission defaults are identical for local, remote, and connected tools.
// A tool allowlist is not equivalent to full bypass: it misses MCP tools and
// tools added by later provider releases. Let Claude enforce its own launch
// requirements rather than silently downgrading the requested permission mode.
export function buildClaudeExecutionPermissionArgs(input: ClaudePermissionInput): string[] {
  return input.dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : [];
}

export const buildClaudeProbePermissionArgs = buildClaudeExecutionPermissionArgs;

/** Claude permits full bypass as root only inside an identified sandbox. */
export function claudeSandboxPermissionEnv(input: {
  dangerouslySkipPermissions: boolean;
<<<<<<< ours
  targetIsRemote: boolean;
  localProcessUid?: number | null;
  // Keys of the run's `--mcp-config` servers. The allowlist names only
  // built-in tools, so without an `mcp__<server>` entry per server every
  // connected tool is listed to the model and then refused at call time.
  mcpServerNames?: string[];
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  if (shouldUseAllowedTools(input)) {
    const mcpEntries = (input.mcpServerNames ?? []).map((name) => `mcp__${name}`);
    return ["--allowedTools", [SANDBOX_ALLOWED_TOOLS, ...mcpEntries].join(" ")];
  }
  return ["--dangerously-skip-permissions"];
||||||| base
  targetIsRemote: boolean;
  localProcessUid?: number | null;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  if (shouldUseAllowedTools(input)) {
    return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  }
  return ["--dangerously-skip-permissions"];
=======
  targetIsSandbox: boolean;
}): Record<string, string> {
  return input.dangerouslySkipPermissions && input.targetIsSandbox ? { IS_SANDBOX: "1" } : {};
>>>>>>> theirs
}

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterEnvironmentCheck,
  AdapterRuntimeMcpServer,
} from "@paperclipai/adapter-utils";
import { toPaperclipServerKey } from "@paperclipai/adapter-utils/runtime-mcp-staging";
import {
  adapterExecutionTargetUsesManagedHome,
  maybeRunSandboxInstallCommand,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
  type AdapterExecutionTargetShellOptions,
} from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { classifyThrownErrorClass, logSandboxProbeDiagnostic } from "./probe-diagnostics.js";

const SEEDED_SHARED_FILES = ["settings.json", "CLAUDE.md"] as const;
// User-level subagent definitions (`$CLAUDE_CONFIG_DIR/agents/*.md`). Without
// them a remote sandbox run cannot dispatch a subagent the host config defines.
const SEEDED_AGENTS_DIR = "agents";

interface SeedFile {
  name: string;
  sourcePath: string;
  contents: Buffer;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function sanitizeRemoteClaudeSettings(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  const settings = { ...(parsed as Record<string, unknown>) };
  settings.permissions = { defaultMode: "default" };
  delete settings.hooks;
  delete settings.mcpServers;
  delete settings.permissionMode;
  delete settings.skipDangerousModePermissionPrompt;
  return JSON.stringify(settings);
}

async function collectSeedFiles(sourceDir: string): Promise<SeedFile[]> {
  const files: SeedFile[] = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    const rawContents = await fs.readFile(sourcePath);
    const contents = name === "settings.json"
      ? Buffer.from(sanitizeRemoteClaudeSettings(rawContents.toString("utf8")), "utf8")
      : rawContents;
    files.push({ name, sourcePath, contents });
  }
  files.push(...(await collectSeedAgentFiles(sourceDir)));
  return files;
}

/**
 * Regular `*.md` files directly under `agents/`, sorted so the snapshot hash is
 * stable. A symbolic link (the directory itself or an entry) is skipped, so the
 * seed never pulls an arbitrary host file into the sandbox.
 */
async function collectSeedAgentFiles(sourceDir: string): Promise<SeedFile[]> {
  const agentsDir = path.join(sourceDir, SEEDED_AGENTS_DIR);
  const dirStat = await fs.lstat(agentsDir).catch(() => null);
  if (!dirStat?.isDirectory()) return [];
  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  const files: SeedFile[] = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".md"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const sourcePath = path.join(agentsDir, entry.name);
    files.push({
      name: path.posix.join(SEEDED_AGENTS_DIR, entry.name),
      sourcePath,
      contents: await fs.readFile(sourcePath),
    });
  }
  return files;
}

/**
 * Copy the regular `agents/*.md` subagent definitions from one Claude config dir
 * into another, with the same rules as the seed (no symbolic links, no nested
 * dirs). A managed AI connection replaces the agent's `CLAUDE_CONFIG_DIR` with a
 * fresh per-run home; this carries the agent's subagents into it. Returns the
 * copied file names.
 */
export async function copyClaudeUserAgentDefinitions(
  sourceDir: string,
  targetDir: string,
): Promise<string[]> {
  const files = await collectSeedAgentFiles(sourceDir);
  if (files.length === 0) return [];
  await fs.mkdir(path.join(targetDir, SEEDED_AGENTS_DIR), { recursive: true });
  for (const file of files) {
    await fs.writeFile(path.join(targetDir, ...file.name.split("/")), file.contents);
  }
  return files.map((file) => file.name);
}

/**
 * Copy the prompt bundle's `.claude/skills/*` into `<configDir>/skills`. The
 * bundle reaches Claude via `--add-dir` (project-scope skills), but a managed
 * connection run passes `--setting-sources user`, which drops project sources,
 * so the skills are only visible if they also live in the user config dir.
 * Each skill entry is a symlink to its source dir, so only that top-level link
 * is resolved; symlinks nested inside a skill are skipped so a skill can never
 * pull an arbitrary host file into the config dir. A skill that fails to copy
 * is removed rather than left half-written. Returns the copied skill names.
 */
export async function copyClaudeBundleSkills(
  bundleDir: string,
  configDir: string,
): Promise<string[]> {
  const sourceDir = path.join(bundleDir, ".claude", "skills");
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  const copied: string[] = [];
  for (const name of names) {
    const targetPath = path.join(configDir, "skills", name);
    try {
      const resolvedSource = await fs.realpath(path.join(sourceDir, name));
      if (!(await fs.stat(resolvedSource)).isDirectory()) continue;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.rm(targetPath, { recursive: true, force: true });
      await fs.cp(resolvedSource, targetPath, {
        recursive: true,
        filter: async (source) => !(await fs.lstat(source)).isSymbolicLink(),
      });
      copied.push(name);
    } catch {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return copied;
}

async function buildSeedSnapshotKey(files: SeedFile[]): Promise<string> {
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function materializeSeedSnapshot(input: {
  rootDir: string;
  snapshotKey: string;
  files: SeedFile[];
}): Promise<string> {
  const targetDir = path.join(input.rootDir, input.snapshotKey);
  if (await pathExists(targetDir)) {
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      const targetPath = path.join(stagingDir, ...file.name.split("/"));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, file.contents);
    }
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return targetDir;
}

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export function resolveManagedClaudeConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-config-seed")
    : path.resolve(instanceRoot, "claude-config-seed");
}

export function resolveManagedClaudeRuntimeStateDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.join(instanceRoot, "companies", companyId, "agents", agentId, "claude-runtime");
}

/**
 * CH-22: the `mcpServers` map, separated from the file write so the shared
 * staging helper can produce the same entries when it owns the file. Keys carry
 * the Paperclip prefix, which is what lets a merge tell its own entries from a
 * workspace's own.
 */
export function buildPaperclipClaudeMcpServerEntries(
  servers: AdapterRuntimeMcpServer[],
): Record<string, unknown> {
  const usedNames = new Set<string>();
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[toPaperclipServerKey(server, usedNames)] = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
    };
  }
  return mcpServers;
}

export async function writePaperclipClaudeMcpConfig(input: {
  stateDir: string;
  runId: string;
  servers: AdapterRuntimeMcpServer[];
}): Promise<string> {
  const configDir = path.join(input.stateDir, "runs", input.runId, "mcp");
  const configPath = path.join(configDir, "mcp-config.json");
  const mcpServers = buildPaperclipClaudeMcpServerEntries(input.servers);
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return configPath;
}

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  const copiedFiles = await collectSeedFiles(sourceDir);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}

export function buildRemoteClaudeConfigMaterializationCommand(input: {
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
}): string {
  return `mkdir -p ${shellQuote(input.remoteClaudeConfigDir)} && ` +
    `if [ -d ${shellQuote(input.remoteClaudeConfigSeedDir)} ]; then ` +
    `cp -R ${shellQuote(`${input.remoteClaudeConfigSeedDir}/.`)} ${shellQuote(input.remoteClaudeConfigDir)}/; ` +
    `fi; ` +
    `for file in .credentials.json credentials.json; do ` +
    `if [ -n "\${HOME:-}" ] && [ -f "\${HOME}/.claude/\${file}" ] && [ ! -f ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}" ]; then ` +
    `cp "\${HOME}/.claude/\${file}" ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}"; ` +
    `fi; ` +
    `done`;
}

export async function materializeRemoteClaudeConfig(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
  options: AdapterExecutionTargetShellOptions;
}): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: input.remoteClaudeConfigDir,
      remoteClaudeConfigSeedDir: input.remoteClaudeConfigSeedDir,
    }),
    input.options,
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Prepare the sandbox runtime that a Claude hello probe needs. The step
 * installs the Claude CLI in the sandbox when the CLI is absent, and it
 * materializes the Paperclip-managed Claude config directory. Both the CLI
 * Test lane and the ACP Test lane call this helper, so the two lanes probe
 * the same login state. The Claude CLI and the Claude ACP engine share the
 * same stored Claude login.
 *
 * The function mutates `env`: it sets `CLAUDE_CONFIG_DIR` to the managed
 * remote config directory when it materializes one. It returns the checks to
 * add to the Test result. An operator-provided `CLAUDE_CONFIG_DIR` wins, so
 * the function keeps it and skips the managed materialization.
 */
export async function prepareSandboxClaudeProbeRuntime(input: {
  managedAiConnection?: boolean;
  runId: string;
  target: AdapterExecutionTarget | null;
  cwd: string;
  companyId?: string;
  env: Record<string, string>;
  installCommand: string;
  detectCommand: string;
  targetIsRemote: boolean;
  targetIsSandbox: boolean;
  helloProbeTimeoutSec: number;
}): Promise<AdapterEnvironmentCheck[]> {
  const checks: AdapterEnvironmentCheck[] = [];
  const installCheck = await maybeRunSandboxInstallCommand({
    runId: input.runId,
    target: input.target,
    adapterKey: "claude",
    installCommand: input.installCommand,
    detectCommand: input.detectCommand,
    env: input.env,
  });
  if (installCheck) checks.push(installCheck);

  const hasExplicitClaudeConfigDir = isNonEmptyString(input.env.CLAUDE_CONFIG_DIR);
  if (
    input.targetIsRemote &&
    adapterExecutionTargetUsesManagedHome(input.target) &&
    (!hasExplicitClaudeConfigDir || input.managedAiConnection)
  ) {
    let tempWorkspaceDir: string | null = null;
    let preparedRuntime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | null = null;
    try {
      const seedDir = input.managedAiConnection ? input.env.CLAUDE_CONFIG_DIR : await prepareClaudeConfigSeed(process.env, async () => {}, input.companyId);
      const managedRemoteCwd =
        input.target?.kind === "remote" ? input.target.remoteCwd : input.cwd;
      tempWorkspaceDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "paperclip-claude-envtest-workspace-"),
      );
      preparedRuntime = await prepareAdapterExecutionTargetRuntime({
        runId: input.runId,
        target: input.target,
        adapterKey: "claude",
        workspaceLocalDir: tempWorkspaceDir,
        workspaceRemoteDir: managedRemoteCwd,
        timeoutSec: Math.max(1, input.helloProbeTimeoutSec),
        // The probe workspace is a throwaway temp dir; never wait on copy-back retries.
        workspaceRestoreRetryDelaysMs: [],
        assets: [
          {
            key: "config-seed",
            localDir: seedDir,
            followSymlinks: true,
          },
        ],
      });
      const runtimeRootDir =
        preparedRuntime.runtimeRootDir ??
        path.posix.join(managedRemoteCwd, ".paperclip-runtime", "claude");
      const remoteClaudeConfigSeedDir =
        preparedRuntime.assetDirs["config-seed"] ??
        path.posix.join(runtimeRootDir, "config-seed");
      const remoteClaudeConfigDir = path.posix.join(runtimeRootDir, "config");
      input.env.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
      await materializeRemoteClaudeConfig({
        runId: input.runId,
        target: input.target,
        remoteClaudeConfigDir,
        remoteClaudeConfigSeedDir,
        options: {
          cwd: input.cwd,
          env: input.env,
          timeoutSec: Math.max(15, input.helloProbeTimeoutSec),
          graceSec: 5,
          onLog: async () => {},
        },
      });
      checks.push({
        code: "claude_managed_config_dir",
        level: "info",
        message: "The environment probe is using Paperclip-managed Claude config materialization.",
        detail: remoteClaudeConfigDir,
      });
    } catch (err) {
      // Keep the raw error out of the Test-result check and the server log. Log
      // only the fixed context, the allowlisted classification, and a safe
      // error class name.
      logSandboxProbeDiagnostic(
        "Could not materialize Paperclip-managed Claude config for the environment probe",
        "spawn_error",
        { errorClass: classifyThrownErrorClass(err) },
      );
      checks.push({
        code: "claude_managed_config_dir_failed",
        level: "error",
        message: "Could not materialize Paperclip-managed Claude config for the environment probe.",
        hint: "Retry the Test. If the failure repeats, check the server log for the redacted diagnostic.",
      });
    } finally {
      await preparedRuntime?.restoreWorkspace().catch(() => undefined);
      if (tempWorkspaceDir) {
        await fs.rm(tempWorkspaceDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  return checks;
}

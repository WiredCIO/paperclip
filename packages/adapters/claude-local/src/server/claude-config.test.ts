import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// A shared handle so the managed-config test can force the runtime preparation
// step to throw an error that carries untrusted markers.
const { prepareAdapterExecutionTargetRuntime } = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    adapterExecutionTargetUsesManagedHome: () => true,
    maybeRunSandboxInstallCommand: async () => null,
    prepareAdapterExecutionTargetRuntime,
  };
});

import {
  copyClaudeBundleSkills,
  copyClaudeUserAgentDefinitions,
  prepareClaudeConfigSeed,
  prepareSandboxClaudeProbeRuntime,
} from "./claude-config.js";

describe("prepareClaudeConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "light",
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "local" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.access(path.join(first, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing snapshot intact when the seeded files change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-race-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }));
  });

  it("strips local-only settings from remote Claude config seeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-boundary-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "local" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "local instructions", "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const remoteSettings = JSON.parse(await fs.readFile(path.join(seedDir, "settings.json"), "utf8"));

    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.hooks).toBeUndefined();
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });

  it("seeds user-level subagents from agents/*.md and skips symbolic links", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-agents-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    const agentsDir = path.join(sourceDir, "agents");
    await fs.mkdir(path.join(agentsDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(agentsDir, "hostile-reviewer.md"), "# hostile-reviewer subagent", "utf8");
    await fs.writeFile(path.join(agentsDir, "notes.txt"), "not an agent", "utf8");
    await fs.writeFile(path.join(agentsDir, "nested", "deep.md"), "nested", "utf8");
    const outside = path.join(root, "outside-secret.md");
    await fs.writeFile(outside, "host secret", "utf8");
    let symlinkCreated = true;
    await fs.symlink(outside, path.join(agentsDir, "linked.md")).catch(() => {
      symlinkCreated = false;
    });

    const onLog = vi.fn(async () => {});
    const seedDir = await prepareClaudeConfigSeed(createEnv(root, sourceDir), onLog, "company-1");

    await expect(fs.readFile(path.join(seedDir, "agents", "hostile-reviewer.md"), "utf8"))
      .resolves.toBe("# hostile-reviewer subagent");
    expect((await fs.readdir(path.join(seedDir, "agents"))).sort()).toEqual(["hostile-reviewer.md"]);
    if (symlinkCreated) {
      await expect(fs.access(path.join(seedDir, "agents", "linked.md")))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(onLog).toHaveBeenCalledWith("stdout", expect.stringContaining("agents/hostile-reviewer.md"));
  });

  it("skips an agents directory that is itself a symbolic link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-agents-link-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    const realAgents = path.join(root, "elsewhere");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(realAgents, { recursive: true });
    await fs.writeFile(path.join(realAgents, "reviewer.md"), "reviewer", "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "guidance", "utf8");
    try {
      await fs.symlink(realAgents, path.join(sourceDir, "agents"), "junction");
    } catch {
      return; // The platform refused to create the link; nothing to assert.
    }

    const seedDir = await prepareClaudeConfigSeed(createEnv(root, sourceDir), vi.fn(async () => {}), "company-1");

    await expect(fs.access(path.join(seedDir, "agents")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8")).resolves.toBe("guidance");
  });

  it("produces a new snapshot when a subagent definition changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-agents-hash-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(path.join(sourceDir, "agents"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "guidance", "utf8");
    const env = createEnv(root, sourceDir);
    const onLog = vi.fn(async () => {});

    const withoutAgents = await prepareClaudeConfigSeed(env, onLog, "company-1");
    await fs.writeFile(path.join(sourceDir, "agents", "reviewer.md"), "v1", "utf8");
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    await fs.writeFile(path.join(sourceDir, "agents", "reviewer.md"), "v2", "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).not.toBe(withoutAgents);
    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "agents", "reviewer.md"), "utf8")).resolves.toBe("v1");
    await expect(fs.readFile(path.join(second, "agents", "reviewer.md"), "utf8")).resolves.toBe("v2");
  });

  it("copies only regular agents/*.md into a managed connection home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-agents-copy-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "seat");
    const targetDir = path.join(root, "provider");
    await fs.mkdir(path.join(sourceDir, "agents"), { recursive: true });
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "agents", "deep-analyst.md"), "analyst", "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), "{}", "utf8");

    await expect(copyClaudeUserAgentDefinitions(sourceDir, targetDir)).resolves.toEqual(["agents/deep-analyst.md"]);
    await expect(fs.readFile(path.join(targetDir, "agents", "deep-analyst.md"), "utf8")).resolves.toBe("analyst");
    expect(await fs.readdir(targetDir)).toEqual(["agents"]);
    await expect(copyClaudeUserAgentDefinitions(path.join(root, "missing"), targetDir)).resolves.toEqual([]);
  });

  it("copies bundle skills, dereferencing symlinks, into a managed connection home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-skills-copy-"));
    cleanupDirs.push(root);
    const bundleDir = path.join(root, "bundle");
    const skillSource = path.join(root, "skill-source", "triage");
    const configDir = path.join(root, "provider");
    await fs.mkdir(path.join(skillSource, "refs"), { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "triage skill", "utf8");
    await fs.writeFile(path.join(skillSource, "refs", "a.md"), "ref", "utf8");
    await fs.mkdir(path.join(bundleDir, ".claude", "skills"), { recursive: true });
    await fs.symlink(skillSource, path.join(bundleDir, ".claude", "skills", "triage"));
    await fs.writeFile(path.join(bundleDir, ".claude", "skills", "stray.txt"), "x", "utf8");
    await fs.mkdir(configDir, { recursive: true });

    await expect(copyClaudeBundleSkills(bundleDir, configDir)).resolves.toEqual(["triage"]);
    const copied = path.join(configDir, "skills", "triage");
    expect((await fs.lstat(copied)).isSymbolicLink()).toBe(false);
    await expect(fs.readFile(path.join(copied, "SKILL.md"), "utf8")).resolves.toBe("triage skill");
    await expect(fs.readFile(path.join(copied, "refs", "a.md"), "utf8")).resolves.toBe("ref");
    expect(await fs.readdir(path.join(configDir, "skills"))).toEqual(["triage"]);

    await expect(copyClaudeBundleSkills(path.join(root, "missing"), configDir)).resolves.toEqual([]);
  });
});

describe("prepareSandboxClaudeProbeRuntime managed-config diagnostics", () => {
  const cleanupDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const sandboxTarget: AdapterExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/home/daytona/paperclip-workspace",
    runner: {
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps a thrown config-materialization error out of every check and the log", async () => {
    // The runtime preparation throws an error that carries two untrusted values:
    // an opaque credential marker and a proxy marker. Neither may reach a check
    // or the server log. The log carries only the fixed context, the allowlisted
    // classification, and the safe error class name.
    const opaqueCredMarker = "OPAQUECREDMARKERconfig";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-mgmt-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });

    for (const key of ["CLAUDE_CONFIG_DIR", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = sourceDir;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    prepareAdapterExecutionTargetRuntime.mockRejectedValueOnce(
      new Error(`materialize failed with ${opaqueCredMarker} via ${proxyMarker}`),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await prepareSandboxClaudeProbeRuntime({
      runId: "run-1",
      target: sandboxTarget,
      // The probe passes no CLAUDE_CONFIG_DIR, so the managed branch runs.
      cwd: "/home/daytona/paperclip-workspace",
      companyId: "company-1",
      env: {},
      installCommand: "install-claude",
      detectCommand: "claude",
      targetIsRemote: true,
      targetIsSandbox: true,
      helloProbeTimeoutSec: 30,
    });

    const failed = checks.find((check) => check.code === "claude_managed_config_dir_failed");
    expect(failed).toBeTruthy();
    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(opaqueCredMarker);
    expect(checkText).not.toContain("proxy.corp.internal");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      classification: "spawn_error",
      errorClass: "Error",
    });
    warnSpy.mockRestore();
  });
});

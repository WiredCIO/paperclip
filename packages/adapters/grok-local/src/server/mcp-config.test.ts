import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  DEFAULT_GROK_MCP_TOOL_TIMEOUT_SEC,
  ensureGrokProjectConfigGitExcluded,
  GROK_GIT_EXCLUDE_ENTRY,
  GROK_PROJECT_CONFIG_DIRNAME,
  GROK_PROJECT_CONFIG_FILENAME,
  renderGrokMcpConfigToml,
  toTomlBasicString,
  writeGrokProjectMcpConfig,
} from "./mcp-config.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-mcp-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function server(overrides: Partial<AdapterRuntimeMcpServer> = {}): AdapterRuntimeMcpServer {
  return {
    name: "Paperclip connections",
    url: "https://paperclip.example/api/runtime-tools/mcp",
    token: "token-abc",
    connectionId: "paperclip-runtime-tools",
    ...overrides,
  };
}

describe("toTomlBasicString", () => {
  it("escapes the structural characters rather than trusting the value", () => {
    expect(toTomlBasicString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(toTomlBasicString("line\nbreak")).toBe('"line\\nbreak"');
    expect(toTomlBasicString("bell")).toBe('"bell\\u0007"');
  });
});

describe("renderGrokMcpConfigToml", () => {
  it("renders a header table after the parent table's scalar keys", () => {
    const toml = renderGrokMcpConfigToml([server()], { runId: "run-1" });
    const urlLine = toml.indexOf("url = ");
    const headerTable = toml.indexOf("[mcp_servers.paperclip-connections.headers]");
    expect(urlLine).toBeGreaterThan(-1);
    expect(headerTable).toBeGreaterThan(urlLine);
    expect(toml).toContain('Authorization = "Bearer token-abc"');
  });

  it("only emits [mcp_servers] tables, the one section a project config may carry", () => {
    const toml = renderGrokMcpConfigToml(
      [server(), server({ name: "Paperclip projects", connectionId: "paperclip-project-tools" })],
      { runId: "run-1" },
    );
    const tables = toml.match(/^\[[^\]]+\]$/gm) ?? [];
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) expect(table.startsWith("[mcp_servers.")).toBe(true);
  });

  it("disambiguates two servers that normalize to the same key", () => {
    const toml = renderGrokMcpConfigToml(
      [
        server({ name: "Business Central", connectionId: "aaaaaaaa-1111" }),
        server({ name: "business central", connectionId: "bbbbbbbb-2222" }),
      ],
      { runId: "run-1" },
    );
    expect(toml).toContain("[mcp_servers.paperclip-business-central]");
    expect(toml).toContain("[mcp_servers.paperclip-business-central-bbbbbbbb]");
  });

  it("bounds every tool call rather than leaving Grok's 6000s default in place", () => {
    const toml = renderGrokMcpConfigToml([server()], { runId: "run-1" });
    expect(toml).toContain(`tool_timeout_sec = ${DEFAULT_GROK_MCP_TOOL_TIMEOUT_SEC}`);
    expect(toml).not.toContain("6000");
  });

  it("honours a configured tool timeout and ignores a nonsense one", () => {
    expect(renderGrokMcpConfigToml([server()], { runId: "r", toolTimeoutSec: 45 })).toContain(
      "tool_timeout_sec = 45",
    );
    for (const bad of [0, -5, Number.NaN]) {
      expect(renderGrokMcpConfigToml([server()], { runId: "r", toolTimeoutSec: bad })).toContain(
        `tool_timeout_sec = ${DEFAULT_GROK_MCP_TOOL_TIMEOUT_SEC}`,
      );
    }
  });

  it("keeps tool_timeout_sec above the headers sub-table, so it stays a parent key", () => {
    const toml = renderGrokMcpConfigToml([server()], { runId: "run-1" });
    expect(toml.indexOf("tool_timeout_sec")).toBeLessThan(
      toml.indexOf("[mcp_servers.paperclip-connections.headers]"),
    );
  });

  it("omits the header table when a server carries no token", () => {
    const toml = renderGrokMcpConfigToml([server({ token: "" })], { runId: "run-1" });
    expect(toml).not.toContain("headers");
    expect(toml).not.toContain("Authorization");
  });
});

describe("writeGrokProjectMcpConfig", () => {
  it("writes the config into the workspace and reports that it created the directory", async () => {
    const cwd = await makeTempDir();
    const written = await writeGrokProjectMcpConfig({ cwd, servers: [server()], runId: "run-1" });

    expect(written.createdDir).toBe(true);
    expect(written.configPath).toBe(
      path.join(cwd, GROK_PROJECT_CONFIG_DIRNAME, GROK_PROJECT_CONFIG_FILENAME),
    );
    const contents = await fs.readFile(written.configPath, "utf8");
    expect(contents).toContain("[mcp_servers.paperclip-connections]");
    expect(contents).toContain("run-1");
  });

  it("reports an existing .grok directory as not created, so cleanup leaves it in place", async () => {
    const cwd = await makeTempDir();
    await fs.mkdir(path.join(cwd, GROK_PROJECT_CONFIG_DIRNAME), { recursive: true });

    const written = await writeGrokProjectMcpConfig({ cwd, servers: [server()], runId: "run-1" });
    expect(written.createdDir).toBe(false);
  });

  it("excludes the staged config from git, so a broad add cannot commit the token", async () => {
    const cwd = await makeTempDir();
    await fs.mkdir(path.join(cwd, ".git", "info"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".git", "info", "exclude"), "# existing\n*.log\n");

    await expect(ensureGrokProjectConfigGitExcluded(cwd)).resolves.toBe(true);
    const exclude = await fs.readFile(path.join(cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("# existing");
    expect(exclude.split(/\r?\n/)).toContain(GROK_GIT_EXCLUDE_ENTRY);
  });

  it("adds the git exclude entry once, however many runs stage the config", async () => {
    const cwd = await makeTempDir();
    await fs.mkdir(path.join(cwd, ".git", "info"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".git", "info", "exclude"), "");

    await ensureGrokProjectConfigGitExcluded(cwd);
    await expect(ensureGrokProjectConfigGitExcluded(cwd)).resolves.toBe(false);
    const exclude = await fs.readFile(path.join(cwd, ".git", "info", "exclude"), "utf8");
    const hits = exclude.split(/\r?\n/).filter((line) => line.trim() === GROK_GIT_EXCLUDE_ENTRY);
    expect(hits).toHaveLength(1);
  });

  it("does not fail a run in a workspace that has no git exclude file", async () => {
    const cwd = await makeTempDir();
    await expect(ensureGrokProjectConfigGitExcluded(cwd)).resolves.toBe(false);
  });

  it("does not leave the bearer token group- or world-readable", async () => {
    const cwd = await makeTempDir();
    const written = await writeGrokProjectMcpConfig({ cwd, servers: [server()], runId: "run-1" });
    const stats = await fs.stat(written.configPath);
    // Windows does not carry POSIX mode bits; assert only where they are real.
    if (process.platform !== "win32") expect(stats.mode & 0o077).toBe(0);
  });
});

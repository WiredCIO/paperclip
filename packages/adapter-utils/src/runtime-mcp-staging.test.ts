import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PAPERCLIP_MCP_KEY_PREFIX,
  findStaleRuntimeMcpEntries,
  isPaperclipTomlTable,
  listPaperclipTomlKeys,
  mergeGrokTomlMcpServers,
  mergeJsonMcpServers,
  removeTomlServerKeys,
  renderAgentsToolsSection,
  splitTomlBlocks,
  sweepStaleRuntimeMcpTokens,
  toPaperclipServerKey,
  withAgentsToolsSection,
} from "./runtime-mcp-staging.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-mcp-staging-"));
  tempDirs.push(dir);
  return dir;
}

const FOREIGN_TOML = `# my own notes
[marketplace]
enabled = true

[mcp_servers.my-own-thing]
url = "https://internal.example/mcp"
`;

const PAPERCLIP_TOML = `[mcp_servers.paperclip-dataverse]
url = "https://bullpen.example/mcp/gateways/gw1"
[mcp_servers.paperclip-dataverse.headers]
Authorization = "Bearer pcgw_old"
`;

describe("toPaperclipServerKey", () => {
  it("always prefixes, so ownership is decidable without stored state", () => {
    const used = new Set<string>();
    expect(toPaperclipServerKey({ name: "Dataverse (prod)", connectionId: "c1" }, used)).toBe(
      "paperclip-dataverse-prod",
    );
    expect(PAPERCLIP_MCP_KEY_PREFIX).toBe("paperclip-");
  });

  it("disambiguates colliding names by connection id", () => {
    const used = new Set<string>();
    expect(toPaperclipServerKey({ name: "Dataverse", connectionId: "aaaaaaaa1" }, used)).toBe(
      "paperclip-dataverse",
    );
    expect(toPaperclipServerKey({ name: "dataverse", connectionId: "bbbbbbbb2" }, used)).toBe(
      "paperclip-dataverse-bbbbbbbb",
    );
  });

  it("does not double-prefix Paperclip's own server names", () => {
    expect(toPaperclipServerKey({ name: "Paperclip connections", connectionId: "c1" }, new Set())).toBe(
      "paperclip-connections",
    );
  });

  it("never produces a bare prefix for an unusable name", () => {
    expect(toPaperclipServerKey({ name: "///", connectionId: "c1" }, new Set())).toBe(
      "paperclip-server",
    );
  });
});

describe("splitTomlBlocks / isPaperclipTomlTable", () => {
  it("keeps the preamble and one block per table", () => {
    const blocks = splitTomlBlocks(FOREIGN_TOML);
    expect(blocks[0]?.key).toBeNull();
    expect(blocks.map((b) => b.key)).toContain("mcp_servers.my-own-thing");
  });

  it("recognizes Paperclip tables, including sub-tables and quoted keys", () => {
    expect(isPaperclipTomlTable("mcp_servers.paperclip-x")).toBe(true);
    expect(isPaperclipTomlTable("mcp_servers.paperclip-x.headers")).toBe(true);
    expect(isPaperclipTomlTable('mcp_servers."paperclip-x"')).toBe(true);
    expect(isPaperclipTomlTable("mcp_servers.my-own-thing")).toBe(false);
    expect(isPaperclipTomlTable("marketplace")).toBe(false);
    expect(isPaperclipTomlTable(null)).toBe(false);
  });

  it("lists the paperclip keys present", () => {
    expect(listPaperclipTomlKeys(FOREIGN_TOML + PAPERCLIP_TOML)).toEqual([
      "paperclip-dataverse",
    ]);
  });
});

describe("mergeGrokTomlMcpServers", () => {
  const rendered = `[mcp_servers.paperclip-new]
url = "https://bullpen.example/mcp/gateways/gw2"
`;

  it("keeps a foreign server and its comments, and adds ours", () => {
    const merged = mergeGrokTomlMcpServers(FOREIGN_TOML, rendered);
    expect(merged).toContain("# my own notes");
    expect(merged).toContain("[marketplace]");
    expect(merged).toContain("[mcp_servers.my-own-thing]");
    expect(merged).toContain("[mcp_servers.paperclip-new]");
  });

  it("replaces a previous paperclip entry rather than duplicating it", () => {
    const merged = mergeGrokTomlMcpServers(FOREIGN_TOML + PAPERCLIP_TOML, rendered);
    expect(merged).not.toContain("paperclip-dataverse");
    expect(merged).not.toContain("pcgw_old");
    expect(merged).toContain("[mcp_servers.paperclip-new]");
    expect(merged).toContain("[mcp_servers.my-own-thing]");
  });

  it("removing everything paperclip leaves the foreign file intact", () => {
    const merged = mergeGrokTomlMcpServers(FOREIGN_TOML + PAPERCLIP_TOML, "");
    expect(merged).toContain("[mcp_servers.my-own-thing]");
    expect(merged).not.toContain("paperclip-");
  });

  it("handles an empty existing file", () => {
    expect(mergeGrokTomlMcpServers("", rendered).trim()).toBe(rendered.trim());
  });
});

describe("mergeJsonMcpServers", () => {
  it("keeps foreign servers and replaces paperclip ones", () => {
    const existing = JSON.stringify({
      mcpServers: {
        mine: { url: "https://internal.example/mcp" },
        "paperclip-old": { url: "https://bullpen.example/old" },
      },
    });
    const merged = JSON.parse(
      mergeJsonMcpServers(existing, { "paperclip-new": { url: "https://bullpen.example/new" } }),
    );
    expect(Object.keys(merged.mcpServers).sort()).toEqual(["mine", "paperclip-new"]);
  });

  it("preserves unrelated top-level keys", () => {
    const merged = JSON.parse(
      mergeJsonMcpServers(JSON.stringify({ somethingElse: 1 }), { "paperclip-a": {} }),
    );
    expect(merged.somethingElse).toBe(1);
  });

  it("refuses to rewrite an unparseable file", () => {
    expect(() => mergeJsonMcpServers("{not json", {})).toThrow(SyntaxError);
  });

  it("handles no existing file", () => {
    const merged = JSON.parse(mergeJsonMcpServers(null, { "paperclip-a": { url: "u" } }));
    expect(merged.mcpServers["paperclip-a"].url).toBe("u");
  });
});

describe("findStaleRuntimeMcpEntries", () => {
  const origins = ["https://bullpen.example"];

  it("flags a paperclip entry whose bearer is not from this run", () => {
    expect(
      findStaleRuntimeMcpEntries({ source: PAPERCLIP_TOML, origins, currentTokens: ["pcgw_live"] }),
    ).toEqual(["paperclip-dataverse"]);
  });

  it("leaves this run's own entry alone", () => {
    expect(
      findStaleRuntimeMcpEntries({ source: PAPERCLIP_TOML, origins, currentTokens: ["pcgw_old"] }),
    ).toEqual([]);
  });

  it("ignores a foreign server even with an unknown bearer", () => {
    const foreign = `[mcp_servers.mine]
url = "https://bullpen.example/mcp/gateways/gw9"
[mcp_servers.mine.headers]
Authorization = "Bearer whatever"
`;
    expect(findStaleRuntimeMcpEntries({ source: foreign, origins, currentTokens: [] })).toEqual([]);
  });

  it("ignores a paperclip entry pointing at a different deployment", () => {
    expect(
      findStaleRuntimeMcpEntries({
        source: PAPERCLIP_TOML,
        origins: ["https://other.example"],
        currentTokens: [],
      }),
    ).toEqual([]);
  });
});

describe("sweepStaleRuntimeMcpTokens", () => {
  it("removes a stale entry under a managed home and reports it", async () => {
    const home = await tempDir();
    const file = path.join(home, "config.toml");
    await fs.writeFile(file, FOREIGN_TOML + PAPERCLIP_TOML);

    const findings = await sweepStaleRuntimeMcpTokens({
      files: [file],
      origins: ["https://bullpen.example"],
      currentTokens: ["pcgw_live"],
      managedRoot: home,
    });

    expect(findings).toEqual([
      { path: file, serverKey: "paperclip-dataverse", removed: true },
    ]);
    const after = await fs.readFile(file, "utf8");
    expect(after).not.toContain("paperclip-dataverse");
    expect(after).toContain("[mcp_servers.my-own-thing]");
  });

  it("reports but does not rewrite a file outside the managed root", async () => {
    const home = await tempDir();
    const file = path.join(home, "config.toml");
    await fs.writeFile(file, PAPERCLIP_TOML);

    const findings = await sweepStaleRuntimeMcpTokens({
      files: [file],
      origins: ["https://bullpen.example"],
      currentTokens: ["pcgw_live"],
      managedRoot: path.join(home, "somewhere-else"),
    });

    expect(findings[0]?.removed).toBe(false);
    expect(await fs.readFile(file, "utf8")).toContain("paperclip-dataverse");
  });

  it("is quiet when nothing is stale", async () => {
    const home = await tempDir();
    const file = path.join(home, "config.toml");
    await fs.writeFile(file, FOREIGN_TOML);
    expect(
      await sweepStaleRuntimeMcpTokens({
        files: [file],
        origins: ["https://bullpen.example"],
        currentTokens: [],
        managedRoot: home,
      }),
    ).toEqual([]);
  });
});

describe("Agents.md Tools section", () => {
  const servers = [{ name: "Dataverse (prod)" }, { name: "Business Central" }];

  it("names every connection and says they are preconfigured", () => {
    const section = renderAgentsToolsSection(servers);
    expect(section).toContain("## Tools");
    expect(section).toContain("- Dataverse (prod)");
    expect(section).toContain("- Business Central");
    expect(section).toMatch(/already configured/i);
  });

  it("renders nothing when there are no servers", () => {
    expect(renderAgentsToolsSection([])).toBe("");
  });

  it("appends to instructions and does not accumulate on repeat", () => {
    const once = withAgentsToolsSection("# Agent\n\nDo the thing.\n", servers);
    const twice = withAgentsToolsSection(once, servers);
    expect(twice).toBe(once);
    expect(twice.match(/## Tools/g)).toHaveLength(1);
    expect(twice).toContain("Do the thing.");
  });

  it("preserves a following section when replacing its own", () => {
    const withTrailing = `# Agent\n\n## Tools\n\n- Stale\n\n## Notes\n\nKeep me.\n`;
    const updated = withAgentsToolsSection(withTrailing, servers);
    expect(updated).toContain("Keep me.");
    expect(updated).not.toContain("- Stale");
    expect(updated).toContain("- Dataverse (prod)");
  });
});

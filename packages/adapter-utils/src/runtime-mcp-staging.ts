/**
 * CH-19: one place that stages Paperclip's runtime MCP servers into whatever
 * config file the runner reads.
 *
 * Each adapter used to render its own. The Grok adapter left a pre-existing
 * `.grok/config.toml` untouched and ran with zero tools, because overwriting a
 * repository's own file was the worse of two bad options. Merging removes the
 * dilemma: foreign entries are preserved byte for byte and only Paperclip's own
 * are replaced.
 *
 * Every key Paperclip writes carries the {@link PAPERCLIP_MCP_KEY_PREFIX}, so
 * "ours" is decidable without keeping state between runs. That is what makes
 * both the merge and the stale-token sweep safe.
 *
 * The TOML merge is deliberately block-based rather than parse-and-reserialize.
 * The file may be a human's, with comments and ordering they care about; a
 * round-trip through a parser would silently rewrite all of it. This only
 * removes the table blocks it owns and appends its own.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "./types.js";

/** Marks every MCP server entry Paperclip owns. */
export const PAPERCLIP_MCP_KEY_PREFIX = "paperclip-";

export type RuntimeMcpFormat = "grok_toml" | "mcp_json";

export interface StaleRuntimeMcpFinding {
  /** File the stale entry was found in. */
  path: string;
  /** The `paperclip-*` key. */
  serverKey: string;
  /** True when the entry was removed, false when it was only reported. */
  removed: boolean;
}

function isPaperclipKey(key: string): boolean {
  return key.startsWith(PAPERCLIP_MCP_KEY_PREFIX);
}

/**
 * Normalizes a Paperclip server name into a config key, always prefixed. Two
 * servers that normalize alike are disambiguated by connection id, so a key is
 * stable across runs for the same connection.
 */
export function toPaperclipServerKey(
  server: Pick<AdapterRuntimeMcpServer, "name" | "connectionId">,
  used: Set<string>,
): string {
  const slug = server.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  // Several of Paperclip's own servers are already named "Paperclip …", so
  // prefixing unconditionally would produce `paperclip-paperclip-connections`.
  const base = slug.startsWith(PAPERCLIP_MCP_KEY_PREFIX)
    ? slug
    : `${PAPERCLIP_MCP_KEY_PREFIX}${slug.length > 0 ? slug : "server"}`;
  let key = base;
  if (used.has(key)) key = `${base}-${server.connectionId.slice(0, 8)}`;
  let suffix = 2;
  while (used.has(key)) {
    key = `${base}-${server.connectionId.slice(0, 8)}-${suffix}`;
    suffix += 1;
  }
  used.add(key);
  return key;
}

// --------------------------------------------------------------------------
// TOML
// --------------------------------------------------------------------------

const TOML_TABLE_HEADER = /^\s*\[\[?([^\]]+)\]\]?\s*$/;

interface TomlBlock {
  /** The dotted table path, or null for the preamble before any table. */
  key: string | null;
  lines: string[];
}

/** Splits a TOML document into its preamble and one block per table header. */
export function splitTomlBlocks(source: string): TomlBlock[] {
  const blocks: TomlBlock[] = [];
  let current: TomlBlock = { key: null, lines: [] };
  for (const line of source.split(/\r?\n/)) {
    const match = TOML_TABLE_HEADER.exec(line);
    if (match) {
      if (current.key !== null || current.lines.some((entry) => entry.trim().length > 0)) {
        blocks.push(current);
      }
      current = { key: match[1]!.trim(), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.key !== null || current.lines.some((entry) => entry.trim().length > 0)) {
    blocks.push(current);
  }
  return blocks;
}

/**
 * True for a table this module owns: `mcp_servers.paperclip-x` and any of its
 * sub-tables, quoted or bare.
 */
export function isPaperclipTomlTable(key: string | null): boolean {
  if (!key) return false;
  const match = /^mcp_servers\.(.+)$/.exec(key.trim());
  if (!match) return false;
  const name = match[1]!.split(".")[0]!.trim().replace(/^"|"$/g, "");
  return isPaperclipKey(name);
}

/** The `paperclip-*` server name a `[mcp_servers.…]` table belongs to. */
function paperclipTomlServerName(key: string): string {
  return /^mcp_servers\.(.+)$/.exec(key.trim())![1]!
    .split(".")[0]!
    .trim()
    .replace(/^"|"$/g, "");
}

/**
 * Collects every Paperclip-owned table into one text per server, so a check
 * that needs both the url and the Authorization header — which live in sibling
 * tables — sees them together.
 */
export function groupPaperclipTomlServers(source: string): Map<string, string> {
  const grouped = new Map<string, string>();
  for (const block of splitTomlBlocks(source)) {
    if (!isPaperclipTomlTable(block.key)) continue;
    const name = paperclipTomlServerName(block.key!);
    const text = block.lines.join("\n");
    grouped.set(name, grouped.has(name) ? `${grouped.get(name)}\n${text}` : text);
  }
  return grouped;
}

/** Every `paperclip-*` server key present in a TOML document. */
export function listPaperclipTomlKeys(source: string): string[] {
  return [...groupPaperclipTomlServers(source).keys()];
}

/**
 * Replaces every Paperclip-owned `[mcp_servers.*]` table with `rendered`,
 * leaving all other content — comments, ordering, foreign servers — untouched.
 */
export function mergeGrokTomlMcpServers(existing: string, rendered: string): string {
  const kept = splitTomlBlocks(existing).filter((block) => !isPaperclipTomlTable(block.key));
  const keptText = kept
    .map((block) => block.lines.join("\n"))
    .join("\n")
    .replace(/\s+$/, "");
  const renderedText = rendered.replace(/^\s+|\s+$/g, "");
  if (keptText.length === 0) return `${renderedText}\n`;
  if (renderedText.length === 0) return `${keptText}\n`;
  return `${keptText}\n\n${renderedText}\n`;
}

// --------------------------------------------------------------------------
// JSON (.mcp.json and friends)
// --------------------------------------------------------------------------

/**
 * Merges Paperclip servers into an `{ mcpServers: {...} }` document, dropping
 * any previous `paperclip-*` keys and keeping every foreign one.
 */
export function mergeJsonMcpServers(
  existing: string | null,
  servers: Record<string, unknown>,
): string {
  let parsed: Record<string, unknown> = {};
  if (existing && existing.trim().length > 0) {
    try {
      const candidate = JSON.parse(existing);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // An unparseable file is left behind entirely rather than silently
      // rewritten: the caller reports it and stages nothing.
      throw new SyntaxError("Existing MCP JSON config is not valid JSON");
    }
  }
  const existingServers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existingServers)) {
    if (isPaperclipKey(key)) continue;
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(servers)) merged[key] = value;
  return `${JSON.stringify({ ...parsed, mcpServers: merged }, null, 2)}\n`;
}

// --------------------------------------------------------------------------
// Stale token sweep
// --------------------------------------------------------------------------

/**
 * Finds `paperclip-*` entries in a config file that point at one of this
 * deployment's origins but carry a bearer that is not from this run.
 *
 * These are the residue of a hand-added server or an earlier run that did not
 * clean up. They are worse than useless: the token is dead, so the tools appear
 * configured and fail at call time, which is exactly how #27 presented.
 */
export function findStaleRuntimeMcpEntries(input: {
  source: string;
  origins: readonly string[];
  currentTokens: readonly string[];
}): string[] {
  const origins = input.origins.filter((origin) => origin.trim().length > 0);
  if (origins.length === 0) return [];
  const current = new Set(input.currentTokens.filter((token) => token.trim().length > 0));
  const stale: string[] = [];
  // A server's url and its Authorization header live in sibling tables
  // (`[mcp_servers.x]` and `[mcp_servers.x.headers]`), so the verdict needs
  // both. Group every block belonging to one server before judging it.
  for (const [name, text] of groupPaperclipTomlServers(input.source)) {
    if (!origins.some((origin) => text.includes(origin))) continue;
    const bearer = /Authorization\s*=\s*"Bearer ([^"]+)"/.exec(text)?.[1];
    if (!bearer) continue;
    if (current.has(bearer)) continue;
    if (!stale.includes(name)) stale.push(name);
  }
  return stale;
}

/**
 * Removes named `paperclip-*` server tables from a TOML document, leaving
 * everything else intact.
 */
export function removeTomlServerKeys(source: string, keys: readonly string[]): string {
  const doomed = new Set(keys);
  const kept = splitTomlBlocks(source).filter((block) => {
    if (!isPaperclipTomlTable(block.key)) return true;
    return !doomed.has(paperclipTomlServerName(block.key!));
  });
  return `${kept.map((block) => block.lines.join("\n")).join("\n").replace(/\s+$/, "")}\n`;
}

/**
 * Sweeps a Paperclip-managed home for stale entries. Only files under a
 * directory Paperclip owns are rewritten; anywhere else the finding is
 * reported and the file left alone.
 */
export async function sweepStaleRuntimeMcpTokens(input: {
  files: readonly string[];
  origins: readonly string[];
  currentTokens: readonly string[];
  /** Absolute path Paperclip manages; only files beneath it are rewritten. */
  managedRoot?: string | null;
}): Promise<StaleRuntimeMcpFinding[]> {
  const findings: StaleRuntimeMcpFinding[] = [];
  for (const file of input.files) {
    const source = await fs.readFile(file, "utf8").catch(() => null);
    if (!source) continue;
    const stale = findStaleRuntimeMcpEntries({
      source,
      origins: input.origins,
      currentTokens: input.currentTokens,
    });
    if (stale.length === 0) continue;
    const managed =
      typeof input.managedRoot === "string" &&
      input.managedRoot.length > 0 &&
      !path.relative(input.managedRoot, file).startsWith("..");
    if (managed) {
      await fs.writeFile(file, removeTomlServerKeys(source, stale), { mode: 0o600 });
    }
    for (const serverKey of stale) findings.push({ path: file, serverKey, removed: managed });
  }
  return findings;
}

// --------------------------------------------------------------------------
// Agent-readable tool guidance
// --------------------------------------------------------------------------

/**
 * The generated `## Tools` section appended to a staged instructions file.
 *
 * `PAPERCLIP_RUNTIME_TOOLS_GUIDANCE` is an environment variable nothing
 * surfaces to a model, so an agent had no way to learn its tools were already
 * configured. Stating it in the instructions is the one place the model
 * reliably reads.
 */
export const PAPERCLIP_TOOLS_SECTION_HEADING = "## Tools";

export function renderAgentsToolsSection(
  servers: readonly Pick<AdapterRuntimeMcpServer, "name">[],
): string {
  if (servers.length === 0) return "";
  const lines = [
    "",
    PAPERCLIP_TOOLS_SECTION_HEADING,
    "",
    "Paperclip has already configured these MCP servers for this run. They are",
    "connected and authenticated; do not add, re-register, or ask for credentials",
    "for them.",
    "",
  ];
  for (const server of servers) lines.push(`- ${server.name}`);
  lines.push("");
  return lines.join("\n");
}

/** Appends the Tools section to an instructions file, replacing a previous one. */
export function withAgentsToolsSection(
  instructions: string,
  servers: readonly Pick<AdapterRuntimeMcpServer, "name">[],
): string {
  const section = renderAgentsToolsSection(servers);
  // Drop a section this function wrote earlier, so repeated staging does not
  // accumulate copies. Stops at the next heading of the same level.
  const stripped = instructions.replace(
    new RegExp(`\\n*${PAPERCLIP_TOOLS_SECTION_HEADING}\\n[\\s\\S]*?(?=\\n## |$)`, "g"),
    "",
  );
  if (section.length === 0) return `${stripped.replace(/\s+$/, "")}\n`;
  return `${stripped.replace(/\s+$/, "")}\n${section}`;
}

/**
 * CH-6: which origin a run should use to reach Paperclip's own MCP endpoints.
 *
 * For a `kind: "remote"` target the in-sandbox bridge rewrites
 * `PAPERCLIP_API_URL` to a sandbox-local origin, but the runtime MCP server
 * list was still built from the *host's* `PAPERCLIP_API_URL`. REST from a
 * sandbox worked and MCP tool calls pointed at an address the sandbox could
 * not reach — which is why Daytona appeared to fail, with no Tailscale
 * involvement at all.
 *
 * The origin is therefore a property of the execution target, not of the host.
 * An environment declares it through `config.paperclipReachability`; when it
 * says nothing, a local target keeps today's loopback behaviour and a remote
 * target gets the public HTTPS origin, which is the only one a sandbox can
 * reach with nothing but egress 443.
 */

export const PAPERCLIP_REACHABILITY_MODES = [
  "loopback",
  "public_https",
  "bridge",
] as const;

export type PaperclipReachabilityMode = (typeof PAPERCLIP_REACHABILITY_MODES)[number];

export interface PaperclipReachability {
  mode: PaperclipReachabilityMode;
  publicUrl?: string | null;
}

export interface ResolvedPaperclipOrigin {
  mode: PaperclipReachabilityMode;
  /** Origin with no trailing slash and no `/api` suffix, or null when none is usable. */
  origin: string | null;
  /** Set when the mode asked for an origin that could not be resolved. */
  unresolvedReason?: "missing_public_url" | "missing_loopback_url";
}

/** Trims a configured URL to a bare origin: no trailing slash, no `/api` suffix. */
export function normalizePaperclipOrigin(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/\/+$/, "").replace(/\/api$/, "");
}

export function isHttpsOrigin(value: string | null | undefined): boolean {
  const normalized = normalizePaperclipOrigin(value);
  if (!normalized) return false;
  try {
    return new URL(normalized).protocol === "https:";
  } catch {
    return false;
  }
}

function isReachabilityMode(value: unknown): value is PaperclipReachabilityMode {
  return (
    typeof value === "string" &&
    (PAPERCLIP_REACHABILITY_MODES as readonly string[]).includes(value)
  );
}

/**
 * Reads `paperclipReachability` out of a parsed environment config. Returns
 * null for every shape that does not declare one, so callers fall back to the
 * target-derived default rather than failing a run over a config typo.
 */
export function readPaperclipReachability(config: unknown): PaperclipReachability | null {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return null;
  const raw = (config as Record<string, unknown>).paperclipReachability;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isReachabilityMode(record.mode)) return null;
  const publicUrl = normalizePaperclipOrigin(
    typeof record.publicUrl === "string" ? record.publicUrl : null,
  );
  return { mode: record.mode, ...(publicUrl ? { publicUrl } : {}) };
}

/** The mode that applies when an environment declares nothing. */
export function defaultReachabilityMode(isRemoteTarget: boolean): PaperclipReachabilityMode {
  return isRemoteTarget ? "public_https" : "loopback";
}

/**
 * Resolves the origin to embed in runtime MCP server URLs.
 *
 * `bridge` deliberately resolves to the loopback origin here: under bridge mode
 * the in-sandbox bridge owns the rewrite to its own origin (CH-7, #35), and
 * emitting the host origin keeps the pre-CH-7 behaviour rather than inventing
 * an address nothing serves.
 */
export function resolvePaperclipOrigin(input: {
  isRemoteTarget: boolean;
  reachability?: PaperclipReachability | null;
  /** Host-configured origin, i.e. PAPERCLIP_API_URL. */
  loopbackOrigin?: string | null;
  /** Public origin, i.e. PAPERCLIP_PUBLIC_URL. */
  publicOrigin?: string | null;
}): ResolvedPaperclipOrigin {
  const mode = input.reachability?.mode ?? defaultReachabilityMode(input.isRemoteTarget);
  const loopback = normalizePaperclipOrigin(input.loopbackOrigin);

  if (mode === "public_https") {
    const candidate =
      normalizePaperclipOrigin(input.reachability?.publicUrl) ??
      normalizePaperclipOrigin(input.publicOrigin);
    // A non-HTTPS value is treated as absent: the whole point of this mode is
    // an origin a sandbox can reach over the public internet, and downgrading
    // to plain HTTP would send a per-run bearer token in clear text.
    if (candidate && isHttpsOrigin(candidate)) return { mode, origin: candidate };
    return { mode, origin: null, unresolvedReason: "missing_public_url" };
  }

  if (!loopback) return { mode, origin: null, unresolvedReason: "missing_loopback_url" };
  return { mode, origin: loopback };
}

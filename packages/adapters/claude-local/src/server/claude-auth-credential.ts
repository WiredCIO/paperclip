/**
 * CH-9: the Claude OAuth credential, whole.
 *
 * Capture used to keep only `claudeAiOauth.accessToken`, so a managed Anthropic
 * subscription died as soon as that token expired — there was no refresh token
 * to renew it with. Codex has kept access, refresh and id tokens since it
 * shipped; this module gives Claude the same treatment, plus the freshness
 * predicate the copy-back needs.
 *
 * Nothing here ever logs, prints, or returns token bytes in an error. The
 * decision functions answer with a code, the way the Codex and Grok predicates
 * do, so a caller can never accidentally surface a credential in a message.
 */

/** Exit/decision code: install the source credential over the destination. */
export const CLAUDE_USE_SOURCE = 10;
/** Keep the destination credential. */
export const CLAUDE_KEEP_DESTINATION = 20;
/** Keep the destination; an expiry was present but not a recognized encoding. */
export const CLAUDE_UNREADABLE_EXPIRY = 21;
/** Keep the destination; the source expiry sat implausibly far ahead of the clock. */
export const CLAUDE_IMPLAUSIBLE_EXPIRY = 22;

export type ClaudeAuthMergeDecision =
  | typeof CLAUDE_USE_SOURCE
  | typeof CLAUDE_KEEP_DESTINATION
  | typeof CLAUDE_UNREADABLE_EXPIRY
  | typeof CLAUDE_IMPLAUSIBLE_EXPIRY;

/**
 * A credential whose expiry is further ahead than this is treated as unusable
 * rather than trusted. Matches the bound the Grok predicate applies: a token
 * claiming to live for years is a parsing mistake or a hostile value, not a
 * long-lived session.
 */
export const CLAUDE_MAX_PLAUSIBLE_EXPIRY_MS = 400 * 24 * 60 * 60 * 1000;

export interface ClaudeOauthValue {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scopes?: unknown;
  subscriptionType?: unknown;
  [key: string]: unknown;
}

export interface ClaudeOauthCredential {
  /** The parsed `claudeAiOauth` object, preserved whole. */
  value: ClaudeOauthValue;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readExpiry(value: unknown): { ok: true; at: number | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, at: null };
  if (typeof value === "number" && Number.isFinite(value)) return { ok: true, at: value };
  // Some writers persist the expiry as a numeric string or an ISO timestamp.
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim().length > 0) return { ok: true, at: numeric };
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return { ok: true, at: parsed };
  }
  return { ok: false };
}

/**
 * Parses a Claude credentials file body. Returns null for anything that is not
 * a `{ claudeAiOauth: { accessToken } }` document, so a caller can treat a
 * legacy bare-token string as "not this shape" without a try/catch.
 */
export function parseClaudeOauthCredential(raw: string): ClaudeOauthCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (oauth === null || typeof oauth !== "object" || Array.isArray(oauth)) return null;
  const record = oauth as Record<string, unknown>;
  const accessToken = readString(record.accessToken);
  if (!accessToken) return null;
  return { value: { ...record, accessToken } as ClaudeOauthValue };
}

/**
 * True when the credential can outlive its access token. A value with no
 * refresh token is exactly the defect CH-9 exists to stop: it authenticates
 * once and then expires with no way back.
 */
export function hasRenewableClaudeOauthValue(value: ClaudeOauthValue | null | undefined): boolean {
  if (!value) return false;
  return readString(value.accessToken) !== null && readString(value.refreshToken) !== null;
}

/** Serializes back into the on-disk credentials file shape. */
export function serializeClaudeOauthCredential(value: ClaudeOauthValue): string {
  return JSON.stringify({ claudeAiOauth: value });
}

/**
 * Decides whether a refreshed credential read back from a run should replace
 * the stored one. Mirrors the Codex and Grok predicates: same identity, and
 * strictly fresher, or the destination stands.
 */
export function decideClaudeAuthMerge(
  sourceRaw: string,
  destinationRaw: string,
  options: { now?: number } = {},
): ClaudeAuthMergeDecision {
  const now = options.now ?? Date.now();
  const source = parseClaudeOauthCredential(sourceRaw);
  const destination = parseClaudeOauthCredential(destinationRaw);

  // Nothing usable to install.
  if (!source || !hasRenewableClaudeOauthValue(source.value)) return CLAUDE_KEEP_DESTINATION;
  // No usable destination: anything renewable beats it.
  if (!destination) return CLAUDE_USE_SOURCE;

  const sourceExpiry = readExpiry(source.value.expiresAt);
  if (!sourceExpiry.ok) return CLAUDE_UNREADABLE_EXPIRY;
  const destinationExpiry = readExpiry(destination.value.expiresAt);
  if (!destinationExpiry.ok) return CLAUDE_UNREADABLE_EXPIRY;

  if (sourceExpiry.at !== null && sourceExpiry.at - now > CLAUDE_MAX_PLAUSIBLE_EXPIRY_MS) {
    return CLAUDE_IMPLAUSIBLE_EXPIRY;
  }

  // An unexpiring source cannot be shown to be fresher, so it does not win.
  if (sourceExpiry.at === null) return CLAUDE_KEEP_DESTINATION;
  if (destinationExpiry.at === null) return CLAUDE_USE_SOURCE;
  return sourceExpiry.at > destinationExpiry.at ? CLAUDE_USE_SOURCE : CLAUDE_KEEP_DESTINATION;
}

import { describe, expect, it } from "vitest";
import {
  CLAUDE_IMPLAUSIBLE_EXPIRY,
  CLAUDE_KEEP_DESTINATION,
  CLAUDE_MAX_PLAUSIBLE_EXPIRY_MS,
  CLAUDE_UNREADABLE_EXPIRY,
  CLAUDE_USE_SOURCE,
  decideClaudeAuthMerge,
  hasRenewableClaudeOauthValue,
  parseClaudeOauthCredential,
  serializeClaudeOauthCredential,
} from "./claude-auth-credential.js";

const NOW = 1_800_000_000_000;

function credential(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: NOW + 3_600_000,
      scopes: ["user:inference"],
      subscriptionType: "max",
      ...overrides,
    },
  });
}

describe("parseClaudeOauthCredential", () => {
  it("keeps the whole oauth object, not just the access token", () => {
    const parsed = parseClaudeOauthCredential(credential());
    expect(parsed?.value.accessToken).toBe("access-1");
    expect(parsed?.value.refreshToken).toBe("refresh-1");
    expect(parsed?.value.subscriptionType).toBe("max");
  });

  it("returns null for a legacy bare token rather than throwing", () => {
    expect(parseClaudeOauthCredential("sk-ant-oat-legacy")).toBeNull();
  });

  it("returns null for shapes that are not a credentials document", () => {
    expect(parseClaudeOauthCredential("{}")).toBeNull();
    expect(parseClaudeOauthCredential(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
    expect(parseClaudeOauthCredential(JSON.stringify({ claudeAiOauth: null }))).toBeNull();
    expect(parseClaudeOauthCredential("[]")).toBeNull();
  });
});

describe("hasRenewableClaudeOauthValue", () => {
  it("requires a refresh token, which is the whole point of CH-9", () => {
    expect(hasRenewableClaudeOauthValue({ accessToken: "a", refreshToken: "r" })).toBe(true);
    expect(hasRenewableClaudeOauthValue({ accessToken: "a" })).toBe(false);
    expect(hasRenewableClaudeOauthValue({ accessToken: "a", refreshToken: "  " })).toBe(false);
    expect(hasRenewableClaudeOauthValue(null)).toBe(false);
  });
});

describe("serializeClaudeOauthCredential", () => {
  it("round-trips through the on-disk shape", () => {
    const parsed = parseClaudeOauthCredential(credential())!;
    const round = parseClaudeOauthCredential(serializeClaudeOauthCredential(parsed.value))!;
    expect(round.value).toEqual(parsed.value);
  });
});

describe("decideClaudeAuthMerge", () => {
  it("installs a strictly fresher refreshed credential", () => {
    const source = credential({ accessToken: "access-2", expiresAt: NOW + 7_200_000 });
    expect(decideClaudeAuthMerge(source, credential(), { now: NOW })).toBe(CLAUDE_USE_SOURCE);
  });

  it("keeps the destination when the source is not fresher", () => {
    const source = credential({ expiresAt: NOW + 60_000 });
    expect(decideClaudeAuthMerge(source, credential(), { now: NOW })).toBe(CLAUDE_KEEP_DESTINATION);
  });

  it("keeps the destination when the source has no refresh token", () => {
    const source = credential({ refreshToken: undefined, expiresAt: NOW + 7_200_000 });
    expect(decideClaudeAuthMerge(source, credential(), { now: NOW })).toBe(CLAUDE_KEEP_DESTINATION);
  });

  it("keeps the destination when the source is unparseable", () => {
    expect(decideClaudeAuthMerge("not json", credential(), { now: NOW })).toBe(
      CLAUDE_KEEP_DESTINATION,
    );
  });

  it("installs over an unusable destination", () => {
    expect(decideClaudeAuthMerge(credential(), "not json", { now: NOW })).toBe(CLAUDE_USE_SOURCE);
  });

  it("refuses an implausibly distant expiry instead of trusting it", () => {
    const source = credential({ expiresAt: NOW + CLAUDE_MAX_PLAUSIBLE_EXPIRY_MS + 1_000 });
    expect(decideClaudeAuthMerge(source, credential(), { now: NOW })).toBe(
      CLAUDE_IMPLAUSIBLE_EXPIRY,
    );
  });

  it("reports an unreadable expiry rather than guessing", () => {
    const source = credential({ expiresAt: { nested: true } });
    expect(decideClaudeAuthMerge(source, credential(), { now: NOW })).toBe(
      CLAUDE_UNREADABLE_EXPIRY,
    );
  });

  it("accepts an ISO or numeric-string expiry", () => {
    const iso = credential({ expiresAt: new Date(NOW + 7_200_000).toISOString() });
    expect(decideClaudeAuthMerge(iso, credential(), { now: NOW })).toBe(CLAUDE_USE_SOURCE);
    const numeric = credential({ expiresAt: String(NOW + 7_200_000) });
    expect(decideClaudeAuthMerge(numeric, credential(), { now: NOW })).toBe(CLAUDE_USE_SOURCE);
  });

  it("does not let a source with no expiry displace a dated destination", () => {
    const source = credential({ expiresAt: undefined, accessToken: "access-2" });
    expect(decideClaudeAuthMerge(source, credential(), { now: NOW })).toBe(
      CLAUDE_KEEP_DESTINATION,
    );
  });
});

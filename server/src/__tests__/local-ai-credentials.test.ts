import { afterEach, describe, expect, it, vi } from "vitest";
import { readVerifiedLocalAiCredential } from "../services/local-ai-credentials.js";
const mocks = vi.hoisted(() => ({ claude: vi.fn(), claudeQuota: vi.fn(), codex: vi.fn(), codexQuota: vi.fn(), readFile: vi.fn(), credentialFile: vi.fn() }));
// Keep the real credential helpers. CH-9 made this path depend on
// parseClaudeOauthCredential / hasRenewableClaudeOauthValue /
// serializeClaudeOauthCredential; a mock that omitted them left them
// `undefined`, so the call threw a TypeError that the catch-all reported as a
// generic "could not verify" — the renewability rule was never exercised and
// the failure named the wrong cause. Only the two I/O functions are faked.
vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-claude-local/server")>()),
  readClaudeToken: mocks.claude,
  fetchClaudeQuota: mocks.claudeQuota,
}));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ readCodexAuthInfo: mocks.codex, fetchCodexQuota: mocks.codexQuota }));
vi.mock("../services/local-ai-credential-file.js", () => ({ readLocalAiCredentialFile: mocks.credentialFile }));
vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.readFile } }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe("explicit local subscription import", () => {
  it("verifies Claude only from the selected isolated home, never the host account", async () => {
    // CH-9: the stored value is now the whole renewable document, not the bare
    // access token, so a run can refresh instead of dying when it expires.
    const renewable = { accessToken: "isolated-claude", refreshToken: "isolated-refresh" };
    mocks.credentialFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: renewable }));
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude"))
      .resolves.toBe(JSON.stringify({ claudeAiOauth: renewable }));
    expect(mocks.credentialFile).toHaveBeenCalledWith("/isolated/claude/.credentials.json");
    expect(mocks.claudeQuota).toHaveBeenCalledWith("isolated-claude");
    expect(mocks.claude).not.toHaveBeenCalled();
  });
  it("does not fall back to ambient Claude auth when an isolated login is absent or invalid", async () => {
    mocks.claude.mockResolvedValue("server-operator-token");
    mocks.credentialFile.mockRejectedValue(new Error("No file"));
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).rejects.toThrow("sign-in command shown");
    mocks.credentialFile.mockResolvedValue("malformed");
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).rejects.toThrow("sign-in command shown");
    expect(mocks.claude).not.toHaveBeenCalled();
    expect(mocks.claudeQuota).not.toHaveBeenCalled();
  });
  it("tries the alternate Claude filename after malformed JSON", async () => {
    const alternate = { accessToken: "alternate-token", refreshToken: "alternate-refresh" };
    mocks.credentialFile.mockResolvedValueOnce("malformed").mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: alternate }));
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude"))
      .resolves.toBe(JSON.stringify({ claudeAiOauth: alternate }));
    expect(mocks.credentialFile).toHaveBeenLastCalledWith("/isolated/claude/credentials.json");
    expect(mocks.claude).not.toHaveBeenCalled();
  });
  it("refuses a Claude sign-in with no refresh token, and says why", async () => {
    // `claude setup-token` mints exactly this: an access token and nothing to
    // renew it with. It looks like a successful login and dies within hours,
    // so it is rejected at import rather than stored as a doomed seat. The
    // distinct code is what lets the UI tell this apart from "not signed in".
    mocks.credentialFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "no-refresh" } }));
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude"))
      .rejects.toHaveProperty("details.code", "ai_credential_not_renewable");
    // Rejected before the quota probe: there is no point spending a call on a
    // credential that cannot be kept.
    expect(mocks.claudeQuota).not.toHaveBeenCalled();
  });
  it("verifies Claude's local credential, including explicit Keychain access", async () => {
    mocks.claude.mockResolvedValue("fixture-claude");
    await expect(readVerifiedLocalAiCredential("anthropic")).resolves.toBe("fixture-claude");
    expect(mocks.claude).toHaveBeenCalledWith({ allowKeychain: true });
    expect(mocks.claudeQuota).toHaveBeenCalledWith("fixture-claude");
  });
  it("reads Codex refresh credentials only from the isolated login home", async () => {
    mocks.codex.mockResolvedValue({ accessToken: "access", refreshToken: "refresh", idToken: "identity", accountId: "account", lastRefresh: "date" });
    const result = JSON.parse(await readVerifiedLocalAiCredential("openai", "/isolated/login"));
    expect(result.tokens).toEqual({ access_token: "access", refresh_token: "refresh", id_token: "identity", account_id: "account" });
    expect(mocks.codexQuota).toHaveBeenCalledWith("access", "account");
    expect(mocks.codex).toHaveBeenCalledWith("/isolated/login");
  });
  it("verifies a Grok subscription against a fixed endpoint before saving", async () => {
    const credential = JSON.stringify({ "https://issuer.x.ai::11111111-1111-4111-8111-111111111111": { key: "fixture-key", refresh_token: "fixture-refresh" } });
    mocks.readFile.mockResolvedValue(credential);
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await expect(readVerifiedLocalAiCredential("xai", "/isolated/grok")).resolves.toBe(credential);
    expect(mocks.readFile).toHaveBeenCalledWith("/isolated/grok/auth.json", "utf8");
    expect(fetch).toHaveBeenCalledWith("https://api.x.ai/v1/models", expect.objectContaining({ redirect: "error" }));
  });
  it("rejects missing and invalid logins with actionable, redacted errors", async () => {
    mocks.claude.mockResolvedValue(null);
    await expect(readVerifiedLocalAiCredential("anthropic")).rejects.toThrow("claude auth login");
    mocks.claude.mockResolvedValue("fixture-secret");
    mocks.claudeQuota.mockRejectedValue(new Error("credential fixture-secret rejected"));
    await expect(readVerifiedLocalAiCredential("anthropic")).rejects.toThrow(/^Could not verify the local subscription\. Run claude auth login in a terminal on the machine running Paperclip, then try Connect again\.$/);
    mocks.codex.mockResolvedValue({ accessToken: "incomplete" });
    await expect(readVerifiedLocalAiCredential("openai", "/isolated/login")).rejects.toThrow("sign-in command shown");
    expect(mocks.codexQuota).not.toHaveBeenCalled();
  });
  it.each(["openai", "xai"] as const)("never clones the ambient rotating %s login", async (provider) => {
    await expect(readVerifiedLocalAiCredential(provider)).rejects.toThrow("separate local sign-in");
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});

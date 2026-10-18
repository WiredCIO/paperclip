import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";
import fs from "node:fs/promises";
import path from "node:path";
<<<<<<< ours
import {
  readClaudeToken,
  fetchClaudeQuota,
  parseClaudeOauthCredential,
  hasRenewableClaudeOauthValue,
  serializeClaudeOauthCredential,
  type ClaudeOauthCredential,
} from "@paperclipai/adapter-claude-local/server";
||||||| base
import { readClaudeToken, fetchClaudeQuota } from "@paperclipai/adapter-claude-local/server";
=======
import { readIsolatedClaudeKeychainToken } from "@paperclipai/adapter-claude-local/server";
>>>>>>> theirs
import { readCodexAuthInfo, fetchCodexQuota } from "@paperclipai/adapter-codex-local/server";
import { parseGrokAuthPayload, hasUsableGrokAuthValue } from "@paperclipai/adapter-grok-local/server";
import type { AiProvider } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

<<<<<<< ours
/**
 * CH-9: a Claude sign-in that produced no refresh token. Carries no credential
 * material; it exists only so the catch-all below can tell this apart from a
 * generic verification failure and give the operator an actionable message.
 */
class MissingRefreshTokenError extends Error {}

/** Read an owned login home, or an explicitly authorized local-operator import. */
||||||| base
/** Read an owned login home, or an explicitly authorized local-operator import. */
=======
/** Read and verify a connection-specific login home. */
>>>>>>> theirs
export async function readVerifiedLocalAiCredential(provider: AiProvider, loginHome?: string): Promise<string> {
  if (provider === "openrouter") throw unprocessable("OpenRouter requires an API key.");
  if (!loginHome) throw unprocessable(provider === "xai"
    ? "Start local sign-in for this connection before connecting."
    : "Start browser sign-in for this connection before connecting.");
  try {
    if (provider === "anthropic") {
      // Never change process.env or fall back to the server account when an
      // authenticated user's isolated login is missing or invalid.
      // CH-9: keep the whole `claudeAiOauth` object, the way the Codex branch
      // below keeps access/refresh/id. Storing only the access token is why a
      // materialized Claude seat died within hours: there was no refresh token
      // to renew it with.
      let credential: ClaudeOauthCredential | null = null;
      let token: string | null = null;
<<<<<<< ours
      if (loginHome) {
        for (const name of [".credentials.json", "credentials.json"]) {
          const raw = await readLocalAiCredentialFile(path.join(loginHome, name)).catch(() => null);
          if (!raw) continue;
          const parsed = parseClaudeOauthCredential(raw);
          if (!parsed) continue;
          credential = parsed;
          token = parsed.value.accessToken;
          break;
        }
        if (credential && !hasRenewableClaudeOauthValue(credential.value)) {
          // A capture with no refresh token authenticates once and then expires
          // with no way back. Fail it here rather than storing a seat that is
          // already doomed.
          throw new MissingRefreshTokenError();
        }
      } else {
        token = await readClaudeToken({ allowKeychain: true });
||||||| base
      if (loginHome) {
        for (const name of [".credentials.json", "credentials.json"]) {
          const raw = await readLocalAiCredentialFile(path.join(loginHome, name)).catch(() => null);
          if (!raw) continue;
          let parsed;
          try { parsed = JSON.parse(raw); } catch { continue; }
          const value = parsed?.claudeAiOauth?.accessToken;
          if (typeof value === "string" && value.length) { token = value; break; }
        }
      } else {
        token = await readClaudeToken({ allowKeychain: true });
=======
      for (const name of [".credentials.json", "credentials.json"]) {
        const raw = await readLocalAiCredentialFile(path.join(loginHome, name)).catch(() => null);
        if (!raw) continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }
        const value = parsed?.claudeAiOauth?.accessToken;
        if (typeof value === "string" && value.length) { token = value; break; }
>>>>>>> theirs
      }
      // On macOS the CLI stores the isolated login in the auth home's own
      // suffixed Keychain item rather than a credentials file. The helper
      // never consults the unsuffixed operator item.
      if (!token) token = await readIsolatedClaudeKeychainToken(loginHome);
      if (!token) throw new Error("Missing login");
<<<<<<< ours
      await fetchClaudeQuota(token);
      // With a login home we persist the renewable document; the keychain path
      // can only yield a bare token, and stays on the legacy shape.
      return credential ? serializeClaudeOauthCredential(credential.value) : token;
||||||| base
      await fetchClaudeQuota(token);
      return token;
=======
      // Claude's setup-token OAuth flow requests user:inference. The usage API
      // requires user:profile and returns 403 for that valid token, so it cannot
      // serve as a sign-in check. This isolated credential is written only after
      // the provider CLI completes the code exchange successfully.
      return token;
>>>>>>> theirs
    }
    if (provider === "openai") {
      const auth = await readCodexAuthInfo(loginHome);
      if (!auth?.accessToken || !auth.refreshToken || !auth.idToken) throw new Error("Missing login");
      await fetchCodexQuota(auth.accessToken, auth.accountId);
      return JSON.stringify({ tokens: { access_token: auth.accessToken, refresh_token: auth.refreshToken, id_token: auth.idToken, account_id: auth.accountId }, last_refresh: auth.lastRefresh });
    }
    const raw = await fs.readFile(path.join(loginHome!, "auth.json"), "utf8");
    const payload = parseGrokAuthPayload(JSON.parse(raw));
    if (!payload || !hasUsableGrokAuthValue(payload.value)) throw new Error("Missing login");
    const response = await fetch("https://api.x.ai/v1/models", {
      headers: { Authorization: `Bearer ${payload.value.key}` },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Invalid login");
    return raw;
  } catch (error) {
    // CH-9: distinguish "signed in, but not renewably" from "not signed in".
    // `claude setup-token` mints exactly this: an access token with no refresh
    // token, which looks like a successful login and expires within hours.
    if (error instanceof MissingRefreshTokenError) {
      throw unprocessable(
        "That Claude sign-in produced no refresh token, so the connection would stop working as soon as the access token expires. Sign in with the interactive `claude` login and `/login` — not `claude setup-token` — then try Connect again.",
        { code: "ai_credential_not_renewable" },
      );
    }
    // Provider/CLI errors may contain credential material; never return them.
    throw unprocessable(provider === "xai"
      ? "Could not verify the local subscription. Run the sign-in command shown for this connection, finish signing in, then try Connect again."
      : "Could not verify the local subscription. Finish browser sign-in for this connection, then try Connect again.");
  }
}

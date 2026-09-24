import { randomBytes, randomUUID } from "node:crypto";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, eq, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { createDb, authAccounts, authSessions, authUsers } from "@paperclipai/db";
import { loadPaperclipEnvFile } from "../config/env.js";
import { resolveConfigPath } from "../config/store.js";
import { resolveDbUrl } from "./auth-bootstrap-ceo.js";

// The account namespace Better Auth 1.7 stamps on an email/password account.
// Must match `server/src/auth/better-auth.ts`; the `(issuer, accountId)`
// unique index is what makes the upsert below safe to re-run.
const CREDENTIAL_ISSUER = "local:credential";
const CREDENTIAL_PROVIDER = "credential";

function generatePassword() {
  // base64url keeps it copy-pasteable over chat without escaping surprises.
  return randomBytes(18).toString("base64url");
}

export async function setPasswordCommand(opts: {
  email?: string;
  password?: string;
  config?: string;
  dbUrl?: string;
  keepSessions?: boolean;
}) {
  const email = opts.email?.trim().toLowerCase();
  if (!email) {
    p.log.error(`Missing ${pc.cyan("--email")}.`);
    return;
  }

  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);

  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error("Could not resolve database connection. Pass --db-url or set DATABASE_URL.");
    return;
  }

  // An operator-supplied password lands in shell history and `ps`; generating
  // one keeps the plaintext to this process and the single line we print.
  const password = opts.password ?? generatePassword();
  const generated = !opts.password;

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
  };

  try {
    const user = await db
      .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
      .from(authUsers)
      .where(sql`lower(${authUsers.email}) = ${email}`)
      .then((rows) => rows[0]);

    if (!user) {
      p.log.error(`No user with email ${pc.cyan(email)}.`);
      p.log.info("Accounts are created through an invite. This command only resets an existing one.");
      return;
    }

    const hash = await hashPassword(password);
    const now = new Date();

    const existing = await db
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.issuer, CREDENTIAL_ISSUER)))
      .then((rows) => rows[0]);

    if (existing) {
      await db
        .update(authAccounts)
        .set({ password: hash, updatedAt: now })
        .where(eq(authAccounts.id, existing.id));
    } else {
      // Repairs the half-created user a failed sign-up can leave behind: a
      // `user` row with no `account` cannot sign in, sign up again, or reset.
      await db.insert(authAccounts).values({
        id: randomUUID(),
        issuer: CREDENTIAL_ISSUER,
        accountId: user.id,
        providerId: CREDENTIAL_PROVIDER,
        userId: user.id,
        password: hash,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Read back rather than trusting the write: if Better Auth ever changes its
    // hash envelope, this fails loudly here instead of silently locking the
    // account out at the next sign-in.
    const storedHash = await db
      .select({ password: authAccounts.password })
      .from(authAccounts)
      .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.issuer, CREDENTIAL_ISSUER)))
      .then((rows) => rows[0]?.password ?? null);

    if (!storedHash || !(await verifyPassword({ hash: storedHash, password }))) {
      p.log.error("Wrote the password hash but could not verify it back. The account was NOT changed usefully.");
      p.log.info("Check that the CLI and server pin the same better-auth version, then retry.");
      return;
    }

    let revoked = 0;
    if (!opts.keepSessions) {
      const deleted = await db
        .delete(authSessions)
        .where(eq(authSessions.userId, user.id))
        .returning({ id: authSessions.id });
      revoked = deleted.length;
    }

    p.log.success(`Password set for ${pc.cyan(user.email)} (${user.name}).`);
    if (generated) {
      p.log.message(`Temporary password: ${pc.bold(pc.cyan(password))}`);
      p.log.message(pc.dim("Shown once. Send it over a channel you trust, not email or chat logs."));
    }
    if (revoked > 0) p.log.message(pc.dim(`Revoked ${revoked} existing session(s); they must sign in again.`));
  } catch (err) {
    p.log.error(`Could not set password: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "better-auth/crypto";

function readPackageJson(relative: string) {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, string>;
  };
}

describe("auth set-password", () => {
  // `set-password` writes a Better Auth password hash from the CLI process
  // while the server verifies it. Two different better-auth versions can
  // disagree about the hash envelope, which would lock the account out.
  it("pins the same better-auth version as the server", () => {
    const cli = readPackageJson("../../package.json");
    const server = readPackageJson("../../../server/package.json");

    expect(cli.dependencies?.["better-auth"]).toBeDefined();
    expect(cli.dependencies?.["better-auth"]).toBe(server.dependencies?.["better-auth"]);
  });

  it("produces a hash the same library verifies", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    expect(await verifyPassword({ hash, password: "correct-horse-battery-staple" })).toBe(true);
    expect(await verifyPassword({ hash, password: "wrong" })).toBe(false);
    // salt:hash hex, stored verbatim in the `account.password` text column.
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });
});

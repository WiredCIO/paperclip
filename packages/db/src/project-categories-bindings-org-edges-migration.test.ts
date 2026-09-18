import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0280_good_vision.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("project categories/bindings/org edges migration", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it("backfills a null-scope projects:access grant for every existing active user", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-project-bindings-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const activeUserId = randomUUID();
    const pausedUserId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Paperclip', 'T119')`;
    await sql`
      INSERT INTO "company_memberships" ("company_id", "principal_type", "principal_id", "status")
      VALUES
        (${companyId}, 'user', ${activeUserId}, 'active'),
        (${companyId}, 'user', ${pausedUserId}, 'removed')
    `;

    // The fixture starts at the latest schema, so rewind this migration's
    // effects before re-applying it: drop the tables/column it creates and
    // clear any projects:access rows it already backfilled.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`DELETE FROM "principal_permission_grants" WHERE "permission_key" = 'projects:access'`;
    await sql`ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_category_id_project_categories_id_fk"`;
    await sql`ALTER TABLE "projects" DROP COLUMN IF EXISTS "category_id"`;
    await sql`DROP TABLE IF EXISTS "project_bindings"`;
    await sql`DROP TABLE IF EXISTS "project_categories"`;
    await sql`DROP TABLE IF EXISTS "org_edges"`;

    await applyPendingMigrations(database.connectionString);

    const grants = await sql<{ principal_id: string; scope: unknown }[]>`
      SELECT "principal_id", "scope" FROM "principal_permission_grants"
      WHERE "company_id" = ${companyId} AND "permission_key" = 'projects:access'
    `;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.principal_id).toBe(activeUserId);
    expect(grants[0]?.scope).toBeNull();

    const [column] = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'category_id'
    `;
    expect(column?.column_name).toBe("category_id");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects an org edge where an agent manages an agent", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-org-edges-check-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Paperclip', 'T119B')`;

    await expect(
      sql`
        INSERT INTO "org_edges" ("company_id", "member_type", "member_id", "manager_type", "manager_id")
        VALUES (${companyId}, 'agent', ${randomUUID()}, 'agent', ${randomUUID()})
      `,
    ).rejects.toThrow();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});

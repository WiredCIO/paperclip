import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  documents,
  issueComments,
  issueDocuments,
  issues,
  principalPermissionGrants,
  projectCategories,
  projects,
} from "@paperclipai/db";
import { companySearchExtractQuerySchema, companySearchQuerySchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueListProjectVisibility } from "../routes/authz.js";
import { companySearchService } from "../services/company-search.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const PER_BUCKET = 8;
const PAGE_SIZE = 5;

function boardRequest(userId: string) {
  return {
    actor: { type: "board", userId, source: "session", isInstanceAdmin: false },
  } as unknown as Request;
}

async function createMember(db: Db, companyId: string, membershipRole: string) {
  const userId = `user-${randomUUID()}`;
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole,
  });
  return userId;
}

describeEmbeddedPostgres("company search under project visibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixture!: Awaited<ReturnType<typeof seed>>;

  async function seed() {
    const company = await db
      .insert(companies)
      .values({ name: `Search visibility ${randomUUID()}`, issuePrefix: `SV${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const [sales, delivery] = await db
      .insert(projectCategories)
      .values([
        { companyId: company.id, name: "Sales" },
        { companyId: company.id, name: "Delivery" },
      ])
      .returning();
    const [salesProject, deliveryProject] = await db
      .insert(projects)
      .values([
        { companyId: company.id, name: "Sales nebula", categoryId: sales!.id },
        { companyId: company.id, name: "Delivery nebula", categoryId: delivery!.id },
      ])
      .returning();

    // Interleave the buckets so every unfiltered page mixes them.
    const created = await db
      .insert(issues)
      .values(Array.from({ length: PER_BUCKET * 3 }, (_, index) => ({
        companyId: company.id,
        title: `Orbit task ${index}`,
        status: "todo" as const,
        priority: "medium" as const,
        projectId: [salesProject!.id, deliveryProject!.id, null][index % 3]!,
      })))
      .returning();
    const salesIssue = created.find((issue) => issue.projectId === salesProject!.id)!;
    const deliveryIssue = created.find((issue) => issue.projectId === deliveryProject!.id)!;

    await db.insert(issueComments).values([
      { companyId: company.id, issueId: salesIssue.id, body: "Sales zephyr comment" },
      { companyId: company.id, issueId: deliveryIssue.id, body: "Delivery zephyr comment" },
    ]);
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Writer", role: "engineer" })
      .returning();
    const [deliveryDocument] = await db
      .insert(documents)
      .values({
        companyId: company.id,
        title: "Quasar delivery brief",
        latestBody: "Delivery quasar body",
        format: "markdown",
        createdByAgentId: agent!.id,
      })
      .returning();
    await db.insert(issueDocuments).values({
      companyId: company.id,
      issueId: deliveryIssue.id,
      documentId: deliveryDocument!.id,
      key: "brief",
    });

    const ownerId = await createMember(db, company.id, "owner");
    const salesOperatorId = await createMember(db, company.id, "operator");
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: salesOperatorId,
      permissionKey: "projects:access",
      scope: { categoryIds: [sales!.id] },
      grantedByUserId: null,
    });

    const visibleIds = new Set(
      created.filter((issue) => issue.projectId !== deliveryProject!.id).map((issue) => issue.id),
    );
    const noProjectIds = new Set(
      created.filter((issue) => issue.projectId === null).map((issue) => issue.id),
    );
    return {
      company,
      salesProject: salesProject!,
      deliveryProject: deliveryProject!,
      salesIssue,
      deliveryIssue,
      visibleIds,
      noProjectIds,
      ownerId,
      salesOperatorId,
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-search-project-visibility-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    fixture = await seed();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(projectCategories);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function salesVisibility() {
    const visibility = await issueListProjectVisibility(boardRequest(fixture.salesOperatorId), db, fixture.company.id);
    expect(visibility).toMatchObject({ kind: "restricted" });
    return visibility;
  }

  function search(raw: Record<string, unknown>, projectVisibility?: Awaited<ReturnType<typeof salesVisibility>>) {
    return companySearchService(db).search(fixture.company.id, companySearchQuerySchema.parse(raw), { projectVisibility });
  }

  describe("sales-only operator", () => {
    it("keeps Delivery issues out of the issue list q= search", async () => {
      const result = await issueService(db).list(fixture.company.id, {
        projectVisibility: await salesVisibility(),
        q: "zephyr",
      });

      expect(result.map((issue) => issue.id)).toEqual([fixture.salesIssue.id]);
    });

    it("returns no Delivery issue and counts only visible issues", async () => {
      const projectVisibility = await salesVisibility();
      const result = await search({ q: "Orbit", scope: "issues", limit: "50" }, projectVisibility);

      expect(new Set(result.results.map((item) => item.id))).toEqual(fixture.visibleIds);
      expect(result.countsByType.issue).toBe(PER_BUCKET * 2);
      expect(result.filterOptionCounts.projectId).toEqual({ [fixture.salesProject.id]: PER_BUCKET });
    });

    it("paginates over visible issues with no gaps, duplicates or Delivery rows", async () => {
      const projectVisibility = await salesVisibility();
      const ids: string[] = [];
      let pages = 0;
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await search({ q: "Orbit", scope: "issues", limit: String(PAGE_SIZE), offset: String(offset) }, projectVisibility);
        pages += 1;
        ids.push(...page.results.map((item) => item.id));
        expect(page.hasMore).toBe(offset + PAGE_SIZE < PER_BUCKET * 2);
        if (!page.hasMore) break;
      }

      expect(pages).toBe(Math.ceil((PER_BUCKET * 2) / PAGE_SIZE));
      expect(ids).toHaveLength(new Set(ids).size);
      expect(new Set(ids)).toEqual(fixture.visibleIds);
    });

    it("returns no Delivery comment snippet", async () => {
      const result = await search({ q: "zephyr", scope: "comments" }, await salesVisibility());

      expect(result.results.map((item) => item.id)).toEqual([fixture.salesIssue.id]);
      expect(result.countsByType.comment).toBe(1);
      expect(JSON.stringify(result)).not.toContain("Delivery zephyr");
    });

    it("returns no Delivery document snippet or artifact", async () => {
      const projectVisibility = await salesVisibility();
      const all = await search({ q: "quasar" }, projectVisibility);

      expect(all.results).toEqual([]);
      expect(all.countsByType).toMatchObject({ issue: 0, document: 0, artifact: 0 });
      expect(JSON.stringify(all.results)).not.toContain("Quasar");
    });

    it("returns no hidden project result", async () => {
      const result = await search({ q: "nebula", scope: "projects" }, await salesVisibility());

      expect(result.results.map((item) => item.id)).toEqual([fixture.salesProject.id]);
      expect(result.countsByType.project).toBe(1);
    });

    it("keeps Delivery issues out of extract", async () => {
      const result = await companySearchService(db).extract(
        fixture.company.id,
        companySearchExtractQuerySchema.parse({ contains: "zephyr", limit: "50" }),
        { projectVisibility: await salesVisibility() },
      );

      expect(result.results.map((item) => item.issueId)).toEqual([fixture.salesIssue.id]);
    });

    it("shows a member with no projects:access grant only issues with no project", async () => {
      const ungrantedId = await createMember(db, fixture.company.id, "operator");
      const projectVisibility = await issueListProjectVisibility(boardRequest(ungrantedId), db, fixture.company.id);
      const result = await search({ q: "Orbit nebula", scope: "all", limit: "50" }, projectVisibility);
      const issuesOnly = await search({ q: "Orbit", scope: "issues", limit: "50" }, projectVisibility);

      expect(result.countsByType.project).toBe(0);
      expect(new Set(issuesOnly.results.map((item) => item.id))).toEqual(fixture.noProjectIds);
    });
  });

  describe("unrestricted actors", () => {
    it("leaves an owner's search and extract identical to baseline", async () => {
      const projectVisibility = await issueListProjectVisibility(boardRequest(fixture.ownerId), db, fixture.company.id);
      expect(projectVisibility).toBeUndefined();

      for (const raw of [
        { q: "Orbit", limit: String(PAGE_SIZE), offset: String(PAGE_SIZE) },
        { q: "zephyr" },
        { q: "quasar" },
        { q: "nebula" },
      ]) {
        const baseline = await companySearchService(db).search(fixture.company.id, companySearchQuerySchema.parse(raw));
        const withVisibility = await search(raw, projectVisibility);
        expect(JSON.stringify(withVisibility)).toBe(JSON.stringify(baseline));
      }

      const extractQuery = companySearchExtractQuerySchema.parse({ contains: "zephyr" });
      const baseline = await companySearchService(db).extract(fixture.company.id, extractQuery);
      const withVisibility = await companySearchService(db).extract(fixture.company.id, extractQuery, { projectVisibility });
      expect(JSON.stringify(withVisibility)).toBe(JSON.stringify(baseline));
      expect(baseline.results).toHaveLength(2);
    });
  });
});

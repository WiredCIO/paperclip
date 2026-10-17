import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  issues,
  principalPermissionGrants,
  projectCategories,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueListProjectVisibility } from "../routes/authz.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const PER_BUCKET = 20;
const PAGE_SIZE = 25;

function boardRequest(userId: string, extra: Record<string, unknown> = {}) {
  return {
    actor: { type: "board", userId, source: "session", isInstanceAdmin: false, ...extra },
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

describeEmbeddedPostgres("issue list and count under project visibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixture!: Awaited<ReturnType<typeof seed>>;

  async function seed() {
    const company = await db
      .insert(companies)
      .values({ name: `Issue list visibility ${randomUUID()}`, issuePrefix: `IL${randomUUID().slice(0, 6).toUpperCase()}` })
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
        { companyId: company.id, name: "Sales pipeline", categoryId: sales!.id },
        { companyId: company.id, name: "Delivery work", categoryId: delivery!.id },
      ])
      .returning();

    // Interleave the buckets so every page of an unfiltered list mixes them.
    const rows = Array.from({ length: PER_BUCKET * 3 }, (_, index) => ({
      companyId: company.id,
      title: `Issue ${index}`,
      status: "todo" as const,
      priority: "medium" as const,
      projectId: [salesProject!.id, deliveryProject!.id, null][index % 3]!,
    }));
    const created = await db.insert(issues).values(rows).returning();

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
    return { company, salesProject: salesProject!, deliveryProject: deliveryProject!, created, visibleIds, ownerId, salesOperatorId };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-project-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    fixture = await seed();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(projectCategories);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("sales-only operator under enforce", () => {
    beforeEach(() => {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    });

    async function salesVisibility() {
      const visibility = await issueListProjectVisibility(boardRequest(fixture.salesOperatorId), db, fixture.company.id);
      expect(visibility).toMatchObject({ kind: "restricted" });
      return visibility;
    }

    it("lists only Sales issues and issues with no project", async () => {
      const result = await issueService(db).list(fixture.company.id, { projectVisibility: await salesVisibility() });

      expect(result).toHaveLength(PER_BUCKET * 2);
      expect(new Set(result.map((issue) => issue.id))).toEqual(fixture.visibleIds);
      expect(result.some((issue) => issue.projectId === fixture.deliveryProject.id)).toBe(false);
    });

    it("paginates by offset with no gaps or duplicates", async () => {
      const svc = issueService(db);
      const projectVisibility = await salesVisibility();
      const pages = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await svc.list(fixture.company.id, { projectVisibility, limit: PAGE_SIZE, offset });
        pages.push(page);
        if (page.length < PAGE_SIZE) break;
      }

      expect(pages.map((page) => page.length)).toEqual([25, 15]);
      const ids = pages.flat().map((issue) => issue.id);
      expect(ids).toHaveLength(new Set(ids).size);
      expect(new Set(ids)).toEqual(fixture.visibleIds);
    });

    it("paginates by afterId with no gaps or duplicates", async () => {
      const svc = issueService(db);
      const projectVisibility = await salesVisibility();
      const ids: string[] = [];
      let afterId: string | undefined;
      for (;;) {
        const page = await svc.list(fixture.company.id, {
          projectVisibility,
          limit: PAGE_SIZE,
          sortField: "id",
          sortDir: "asc",
          afterId,
        });
        ids.push(...page.map((issue) => issue.id));
        if (page.length < PAGE_SIZE) break;
        afterId = page[page.length - 1]!.id;
      }

      expect(ids).toEqual([...fixture.visibleIds].sort());
    });

    it("counts exactly the issues the pages return", async () => {
      const svc = issueService(db);
      const projectVisibility = await salesVisibility();
      const first = await svc.list(fixture.company.id, { projectVisibility, limit: PAGE_SIZE, offset: 0 });
      const second = await svc.list(fixture.company.id, { projectVisibility, limit: PAGE_SIZE, offset: PAGE_SIZE });

      await expect(svc.count(fixture.company.id, { projectVisibility })).resolves.toBe(first.length + second.length);
      await expect(svc.count(fixture.company.id, { projectVisibility })).resolves.toBe(PER_BUCKET * 2);
    });

    it("keeps Delivery issues out of search results", async () => {
      const result = await issueService(db).list(fixture.company.id, {
        projectVisibility: await salesVisibility(),
        q: "Issue",
      });

      expect(result.length).toBeGreaterThan(0);
      expect(result.every((issue) => fixture.visibleIds.has(issue.id))).toBe(true);
    });

    it("shows a member with no projects:access grant only issues with no project", async () => {
      const ungrantedId = await createMember(db, fixture.company.id, "operator");
      const projectVisibility = await issueListProjectVisibility(boardRequest(ungrantedId), db, fixture.company.id);
      const result = await issueService(db).list(fixture.company.id, { projectVisibility });

      expect(result).toHaveLength(PER_BUCKET);
      expect(result.every((issue) => issue.projectId === null)).toBe(true);
    });
  });

  describe("unrestricted actors", () => {
    it("leaves an owner's list and count identical to baseline", async () => {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
      const svc = issueService(db);
      const projectVisibility = await issueListProjectVisibility(boardRequest(fixture.ownerId), db, fixture.company.id);
      expect(projectVisibility).toBeUndefined();

      const baseline = await svc.list(fixture.company.id, { limit: PAGE_SIZE, offset: PAGE_SIZE });
      const withVisibility = await svc.list(fixture.company.id, { projectVisibility, limit: PAGE_SIZE, offset: PAGE_SIZE });
      expect(JSON.stringify(withVisibility)).toBe(JSON.stringify(baseline));
      await expect(svc.count(fixture.company.id, { projectVisibility })).resolves.toBe(PER_BUCKET * 3);
    });

    it("does not narrow the local implicit board or an instance admin", async () => {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
      const failingDb = new Proxy({}, {
        get() {
          throw new Error("unexpected database access");
        },
      }) as unknown as Db;

      await expect(
        issueListProjectVisibility(boardRequest(fixture.salesOperatorId, { source: "local_implicit" }), failingDb, fixture.company.id),
      ).resolves.toBeUndefined();
      await expect(
        issueListProjectVisibility(boardRequest(fixture.salesOperatorId, { isInstanceAdmin: true }), failingDb, fixture.company.id),
      ).resolves.toBeUndefined();
    });

    it.each(["off", "shadow"])("makes no query and does not narrow in %s mode", async (mode) => {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
      const failingDb = new Proxy({}, {
        get() {
          throw new Error("unexpected database access");
        },
      }) as unknown as Db;

      await expect(
        issueListProjectVisibility(boardRequest(fixture.salesOperatorId), failingDb, fixture.company.id),
      ).resolves.toBeUndefined();
    });
  });
});

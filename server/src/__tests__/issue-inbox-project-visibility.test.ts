import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueRelations,
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

const PER_BUCKET = 4;
const BUCKETS = ["sales", "delivery", "none"] as const;

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

function ids(rows: Array<{ id: string }>) {
  return new Set(rows.map((row) => row.id));
}

describeEmbeddedPostgres("inbox lists and counts under project visibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixture!: Awaited<ReturnType<typeof seed>>;

  async function seed() {
    const company = await db
      .insert(companies)
      .values({ name: `Inbox visibility ${randomUUID()}`, issuePrefix: `IB${randomUUID().slice(0, 6).toUpperCase()}` })
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
    const projectIdByBucket = { sales: salesProject!.id, delivery: deliveryProject!.id, none: null };

    const ownerId = await createMember(db, company.id, "owner");
    const salesOperatorId = await createMember(db, company.id, "operator");
    const otherUserId = await createMember(db, company.id, "operator");
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: salesOperatorId,
      permissionKey: "projects:access",
      scope: { categoryIds: [sales!.id] },
      grantedByUserId: null,
    });

    // Issues the Sales operator created, interleaved across buckets. Every one
    // has a newer comment from someone else, so each is touched and unread.
    const touched = await db
      .insert(issues)
      .values(
        Array.from({ length: PER_BUCKET * BUCKETS.length }, (_, index) => ({
          companyId: company.id,
          title: `Touched ${index}`,
          status: "todo" as const,
          priority: "medium" as const,
          createdByUserId: salesOperatorId,
          projectId: projectIdByBucket[BUCKETS[index % BUCKETS.length]!],
        })),
      )
      .returning();
    await db.insert(issueComments).values(
      touched.map((issue) => ({
        companyId: company.id,
        issueId: issue.id,
        authorUserId: otherUserId,
        body: "Unread update.",
      })),
    );

    // One blocked source per bucket, each waiting on an unassigned leaf in the
    // same project, so every source needs attention in the blocked inbox.
    const blockedSources = [];
    for (const bucket of BUCKETS) {
      const [source, leaf] = await db
        .insert(issues)
        .values([
          { companyId: company.id, title: `Blocked ${bucket}`, status: "blocked", priority: "medium", projectId: projectIdByBucket[bucket] },
          { companyId: company.id, title: `Leaf ${bucket}`, status: "todo", priority: "medium", projectId: projectIdByBucket[bucket] },
        ])
        .returning();
      await db.insert(issueRelations).values({
        companyId: company.id,
        issueId: leaf!.id,
        relatedIssueId: source!.id,
        type: "blocks",
      });
      blockedSources.push(source!);
    }

    const visible = (issue: { projectId: string | null }) => issue.projectId !== deliveryProject!.id;
    return {
      company,
      deliveryProject: deliveryProject!,
      ownerId,
      salesOperatorId,
      touched,
      blockedSources,
      visibleTouchedIds: ids(touched.filter(visible)),
      visibleBlockedIds: ids(blockedSources.filter(visible)),
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-inbox-project-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    fixture = await seed();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(issueRelations);
    await db.delete(issueComments);
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
    async function salesVisibility() {
      const visibility = await issueListProjectVisibility(boardRequest(fixture.salesOperatorId), db, fixture.company.id);
      expect(visibility).toMatchObject({ kind: "restricted" });
      return visibility;
    }

    it("keeps Delivery issues out of the touchedByUserId list", async () => {
      const result = await issueService(db).list(fixture.company.id, {
        touchedByUserId: fixture.salesOperatorId,
        projectVisibility: await salesVisibility(),
      });

      expect(ids(result)).toEqual(fixture.visibleTouchedIds);
      expect(result.some((issue) => issue.projectId === fixture.deliveryProject.id)).toBe(false);
    });

    it("keeps Delivery issues out of the mine inbox (touched and not archived)", async () => {
      const result = await issueService(db).list(fixture.company.id, {
        touchedByUserId: fixture.salesOperatorId,
        inboxArchivedByUserId: fixture.salesOperatorId,
        projectVisibility: await salesVisibility(),
      });

      expect(ids(result)).toEqual(fixture.visibleTouchedIds);
    });

    it("keeps Delivery issues out of the unreadForUserId list", async () => {
      const result = await issueService(db).list(fixture.company.id, {
        unreadForUserId: fixture.salesOperatorId,
        projectVisibility: await salesVisibility(),
      });

      expect(ids(result)).toEqual(fixture.visibleTouchedIds);
    });

    it("counts unread touched issues exactly as the unread list returns them", async () => {
      const svc = issueService(db);
      const projectVisibility = await salesVisibility();
      const list = await svc.list(fixture.company.id, { unreadForUserId: fixture.salesOperatorId, projectVisibility });

      await expect(
        svc.countUnreadTouchedByUser(fixture.company.id, fixture.salesOperatorId, undefined, projectVisibility),
      ).resolves.toBe(list.length);
      expect(list).toHaveLength(PER_BUCKET * 2);
    });

    it("keeps Delivery issues out of listBlockedInboxIssues and its count", async () => {
      const svc = issueService(db);
      const projectVisibility = await salesVisibility();
      const list = await svc.list(fixture.company.id, { attention: "blocked", projectVisibility });

      expect(ids(list)).toEqual(fixture.visibleBlockedIds);
      await expect(svc.count(fixture.company.id, { attention: "blocked", projectVisibility })).resolves.toBe(list.length);
    });
  });

  describe("unrestricted actors", () => {
    // The owner and every actor in off mode resolve to no visibility at all,
    // so they must see every bucket, Delivery included, in each inbox shape.
    async function expectUnnarrowedInbox(projectVisibility: Awaited<ReturnType<typeof issueListProjectVisibility>>) {
      expect(projectVisibility).toBeUndefined();
      const svc = issueService(db);
      const userId = fixture.salesOperatorId;
      const allTouchedIds = ids(fixture.touched);

      for (const filters of [
        { touchedByUserId: userId },
        { touchedByUserId: userId, inboxArchivedByUserId: userId },
        { unreadForUserId: userId },
      ]) {
        expect(ids(await svc.list(fixture.company.id, { ...filters, projectVisibility }))).toEqual(allTouchedIds);
      }
      expect(ids(await svc.list(fixture.company.id, { attention: "blocked", projectVisibility })))
        .toEqual(ids(fixture.blockedSources));
      await expect(svc.countUnreadTouchedByUser(fixture.company.id, userId, undefined, projectVisibility))
        .resolves.toBe(PER_BUCKET * BUCKETS.length);
      await expect(svc.count(fixture.company.id, { attention: "blocked", projectVisibility }))
        .resolves.toBe(BUCKETS.length);
    }

    it("gives an owner every inbox issue, Delivery included", async () => {
      await expectUnnarrowedInbox(
        await issueListProjectVisibility(boardRequest(fixture.ownerId), db, fixture.company.id),
      );
    });

    it("makes no query and narrows nothing for the Sales operator in off mode", async () => {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
      const failingDb = new Proxy({}, {
        get() {
          throw new Error("unexpected database access");
        },
      }) as unknown as Db;

      await expectUnnarrowedInbox(
        await issueListProjectVisibility(boardRequest(fixture.salesOperatorId), failingDb, fixture.company.id),
      );
    });
  });
});

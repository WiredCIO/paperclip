import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  instanceSettings,
  issueDocuments,
  issues,
  principalPermissionGrants,
  projectCategories,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { activityRoutes } from "../routes/activity.js";
import { costRoutes } from "../routes/costs.js";
import { issueRoutes } from "../routes/issues.js";

/**
 * WIR-124 (T6) end to end: the real authorization service denies a
 * Sales-only operator's read of a Delivery issue, and the routes must turn
 * that into the response a random id gets (or drop it from a list).
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("project visibility 404 mapping against the real decideBase", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-visibility-404-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(projectCategories);
    await db.delete(companies);
    await db.delete(authUsers);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function actorFor(companyId: string, userId: string, membershipRole: string): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole }],
    } as Express.Request["actor"];
  }

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", issueRoutes(db, {} as never));
    instance.use("/api", activityRoutes(db));
    instance.use("/api", costRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Visibility 404 ${randomUUID()}`,
      issuePrefix: `V${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [sales] = await db.insert(projectCategories).values({ companyId, name: "Sales" }).returning();
    const [delivery] = await db.insert(projectCategories).values({ companyId, name: "Delivery" }).returning();
    const [salesProject] = await db.insert(projects).values({ companyId, name: "Sales project", categoryId: sales!.id }).returning();
    const [deliveryProject] = await db.insert(projects).values({ companyId, name: "Delivery project", categoryId: delivery!.id }).returning();

    const ownerId = `user-${randomUUID()}`;
    const salesOperatorId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: salesOperatorId, status: "active", membershipRole: "operator" },
    ]);
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: salesOperatorId,
      permissionKey: "projects:access",
      scope: { categoryIds: [sales!.id] },
      grantedByUserId: null,
    });

    const [salesIssue] = await db.insert(issues).values({
      companyId, title: "Sales issue", status: "todo", priority: "medium", projectId: salesProject!.id,
    }).returning();
    const [deliveryIssue] = await db.insert(issues).values({
      companyId, title: "Delivery issue", status: "todo", priority: "medium", projectId: deliveryProject!.id,
    }).returning();

    return {
      companyId,
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      salesIssue: salesIssue!,
      deliveryIssue: deliveryIssue!,
    };
  }

  it("GET /issues/:id/attachments returns the random-id 404 for a Delivery issue", async () => {
    const fixture = await seed();
    const operator = request(app(fixture.salesOperator));
    const hidden = await operator.get(`/api/issues/${fixture.deliveryIssue.id}/attachments`);
    const random = await operator.get(`/api/issues/${randomUUID()}/attachments`);
    expect(random.status).toBe(404);
    expect(hidden.status).toBe(404);
    expect(hidden.text).toBe(random.text);

    await operator.get(`/api/issues/${fixture.salesIssue.id}/attachments`).expect(200);
    await request(app(fixture.owner)).get(`/api/issues/${fixture.deliveryIssue.id}/attachments`).expect(200);
  });

  it("upload, activity and cost-summary answer a Delivery issue like a random id", async () => {
    const fixture = await seed();
    const operator = request(app(fixture.salesOperator));
    const probes: Array<(id: string) => request.Test> = [
      (id) => operator
        .post(`/api/companies/${fixture.companyId}/issues/${id}/attachments`)
        .attach("file", Buffer.from("test"), { filename: "notes.txt", contentType: "text/plain" }),
      (id) => operator.get(`/api/issues/${id}/activity`),
      (id) => operator.get(`/api/issues/${id}/cost-summary`),
    ];
    for (const probe of probes) {
      const hidden = await probe(fixture.deliveryIssue.id);
      const random = await probe(randomUUID());
      expect(random.status).toBe(404);
      expect(hidden.status).toBe(404);
      expect(hidden.text).toBe(random.text);
    }
    const owner = request(app(fixture.owner));
    await owner.get(`/api/issues/${fixture.deliveryIssue.id}/activity`).expect(200);
    await owner.get(`/api/issues/${fixture.deliveryIssue.id}/cost-summary`).expect(200);
  });
});

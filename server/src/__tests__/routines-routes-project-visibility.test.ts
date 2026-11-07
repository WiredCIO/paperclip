import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
  projectCategories,
  projects,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { routineRoutes } from "../routes/routines.js";

/**
 * WIR-1263 (T8b): a Sales-only operator under `enforce` gets the same 404 for
 * a Delivery routine's detail and sub-routes that a random id gets, the list
 * omits it, and a Sales routine's detail never embeds a Delivery issue.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("routine routes honour project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-routes-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(() => {
    vi.unstubAllEnvs();
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
    instance.use("/api", routineRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Routine visibility ${randomUUID()}`,
      issuePrefix: `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [sales] = await db.insert(projectCategories).values({ companyId, name: "Sales" }).returning();
    const [delivery] = await db.insert(projectCategories).values({ companyId, name: "Delivery" }).returning();
    const [salesProject] = await db.insert(projects).values({ companyId, name: "Sales project", categoryId: sales!.id }).returning();
    const [deliveryProject] = await db.insert(projects).values({ companyId, name: "Delivery project", categoryId: delivery!.id }).returning();
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "RoutineAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();

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

    const [deliveryIssue] = await db.insert(issues).values({
      companyId,
      projectId: deliveryProject!.id,
      title: "Delivery secret issue",
    }).returning();
    const [salesIssue] = await db.insert(issues).values({
      companyId,
      projectId: salesProject!.id,
      title: "Sales issue",
    }).returning();

    const [salesRoutine] = await db.insert(routines).values({
      companyId,
      projectId: salesProject!.id,
      assigneeAgentId: agent!.id,
      title: "Sales routine",
      parentIssueId: deliveryIssue!.id,
    }).returning();
    const [deliveryRoutine] = await db.insert(routines).values({
      companyId,
      projectId: deliveryProject!.id,
      assigneeAgentId: agent!.id,
      title: "Delivery routine",
    }).returning();
    const [unboundRoutine] = await db.insert(routines).values({ companyId, title: "Unbound routine" }).returning();

    const [salesRunDelivery] = await db.insert(routineRuns).values({
      companyId,
      routineId: salesRoutine!.id,
      source: "manual",
      status: "issue_created",
      linkedIssueId: deliveryIssue!.id,
    }).returning();
    const [salesRunSales] = await db.insert(routineRuns).values({
      companyId,
      routineId: salesRoutine!.id,
      source: "manual",
      status: "issue_created",
      linkedIssueId: salesIssue!.id,
    }).returning();

    // A live execution issue that drifted into a Delivery project after the run was created.
    const [liveRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
    }).returning();
    await db.insert(issues).values({
      companyId,
      projectId: deliveryProject!.id,
      title: "Delivery live execution",
      status: "in_progress",
      originKind: "routine_execution",
      originId: salesRoutine!.id,
      executionRunId: liveRun!.id,
    });

    return {
      companyId,
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      salesProject: salesProject!,
      deliveryProject: deliveryProject!,
      deliveryIssue: deliveryIssue!,
      salesIssue: salesIssue!,
      salesRoutine: salesRoutine!,
      deliveryRoutine: deliveryRoutine!,
      unboundRoutine: unboundRoutine!,
      salesRunDelivery: salesRunDelivery!,
      salesRunSales: salesRunSales!,
    };
  }

  async function listTitles(actor: Express.Request["actor"], companyId: string, query = "") {
    const res = await request(app(actor)).get(`/api/companies/${companyId}/routines${query}`);
    expect(res.status, res.text).toBe(200);
    return (res.body as Array<{ title: string }>).map((routine) => routine.title).sort();
  }

  it("404s a Delivery routine's detail and sub-routes exactly like a random id", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    for (const suffix of ["", "/revisions", "/runs", "/description/annotations"]) {
      const hidden = await client.get(`/api/routines/${fixture.deliveryRoutine.id}${suffix}`);
      const missing = await client.get(`/api/routines/${randomUUID()}${suffix}`);
      expect(hidden.status, `${suffix || "detail"}: ${hidden.text}`).toBe(404);
      expect(hidden.body, suffix || "detail").toEqual(missing.body);
    }
  });

  it("omits Delivery routines from the list but keeps Sales and unbound routines", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    expect(await listTitles(fixture.salesOperator, fixture.companyId)).toEqual(["Sales routine", "Unbound routine"]);
    expect(await listTitles(fixture.salesOperator, fixture.companyId, `?projectId=${fixture.deliveryProject.id}`)).toEqual([]);
    expect(await listTitles(fixture.salesOperator, fixture.companyId, `?projectId=${fixture.salesProject.id}`)).toEqual([
      "Sales routine",
    ]);
  });

  it("keeps Sales and unbound routine details readable", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    for (const routine of [fixture.salesRoutine, fixture.unboundRoutine]) {
      for (const suffix of ["", "/revisions", "/runs"]) {
        const res = await client.get(`/api/routines/${routine.id}${suffix}`);
        expect(res.status, `${routine.title}${suffix}: ${res.text}`).toBe(200);
      }
    }
  });

  it("never embeds a Delivery issue in a Sales routine's detail, runs or list", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    const detail = await client.get(`/api/routines/${fixture.salesRoutine.id}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.project).toMatchObject({ id: fixture.salesProject.id });
    expect(detail.body.parentIssue).toBeNull();
    expect(detail.body.activeIssue).toBeNull();
    const detailRuns = detail.body.recentRuns as Array<{ id: string; linkedIssueId: string | null; linkedIssue: { id: string } | null }>;
    expect(detailRuns.find((run) => run.id === fixture.salesRunDelivery.id)).toMatchObject({ linkedIssueId: null, linkedIssue: null });
    expect(detailRuns.find((run) => run.id === fixture.salesRunSales.id)).toMatchObject({
      linkedIssueId: fixture.salesIssue.id,
      linkedIssue: { id: fixture.salesIssue.id, title: "Sales issue" },
    });

    const runs = await client.get(`/api/routines/${fixture.salesRoutine.id}/runs`);
    expect(runs.status, runs.text).toBe(200);
    const listedRuns = runs.body as Array<{ id: string; linkedIssueId: string | null; linkedIssue: { id: string } | null }>;
    expect(listedRuns.find((run) => run.id === fixture.salesRunDelivery.id)).toMatchObject({ linkedIssueId: null, linkedIssue: null });
    expect(listedRuns.find((run) => run.id === fixture.salesRunSales.id)).toMatchObject({ linkedIssueId: fixture.salesIssue.id });

    const list = await client.get(`/api/companies/${fixture.companyId}/routines`);
    const listed = (list.body as Array<{ id: string; activeIssue: unknown; lastRun: { linkedIssueId: string | null } | null }>)
      .find((routine) => routine.id === fixture.salesRoutine.id);
    expect(listed?.activeIssue).toBeNull();

    // The routine's own `parentIssueId` column is the routine's data, not an embed, so it stays.
    expect(JSON.stringify(runs.body)).not.toContain(fixture.deliveryIssue.id);
    for (const body of [JSON.stringify(detail.body), JSON.stringify(runs.body), JSON.stringify(list.body)]) {
      expect(body).not.toContain("Delivery secret issue");
      expect(body).not.toContain("Delivery live execution");
    }
  });

  it("leaves owner results identical to an unrestricted read", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.owner));

    expect(await listTitles(fixture.owner, fixture.companyId)).toEqual([
      "Delivery routine",
      "Sales routine",
      "Unbound routine",
    ]);
    const detail = await client.get(`/api/routines/${fixture.salesRoutine.id}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.parentIssue).toMatchObject({ id: fixture.deliveryIssue.id });
    expect(detail.body.activeIssue).toMatchObject({ title: "Delivery live execution" });
    expect(
      (detail.body.recentRuns as Array<{ id: string; linkedIssue: { id: string } | null }>)
        .find((run) => run.id === fixture.salesRunDelivery.id)?.linkedIssue,
    ).toMatchObject({ id: fixture.deliveryIssue.id });
    for (const suffix of ["", "/revisions", "/runs"]) {
      const res = await client.get(`/api/routines/${fixture.deliveryRoutine.id}${suffix}`);
      expect(res.status, `${suffix}: ${res.text}`).toBe(200);
    }
  });

  it("does not narrow anything when project access mode is off or shadow", async () => {
    const fixture = await seed();
    for (const mode of ["off", "shadow"]) {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
      const client = request(app(fixture.salesOperator));
      expect(await listTitles(fixture.salesOperator, fixture.companyId)).toEqual([
        "Delivery routine",
        "Sales routine",
        "Unbound routine",
      ]);
      const detail = await client.get(`/api/routines/${fixture.salesRoutine.id}`);
      expect(detail.body.parentIssue, mode).toMatchObject({ id: fixture.deliveryIssue.id });
      const hidden = await client.get(`/api/routines/${fixture.deliveryRoutine.id}`);
      expect(hidden.status, `${mode}: ${hidden.text}`).toBe(200);
    }
  });

  it("also refuses mutations on a Delivery routine with the same 404", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const res = await request(app(fixture.salesOperator))
      .patch(`/api/routines/${fixture.deliveryRoutine.id}`)
      .send({ title: "renamed" });
    expect(res.status, res.text).toBe(404);
    expect(await listTitles(fixture.owner, fixture.companyId)).toContain("Delivery routine");
  });
});

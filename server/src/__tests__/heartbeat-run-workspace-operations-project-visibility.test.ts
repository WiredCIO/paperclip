import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  principalPermissionGrants,
  projectCategories,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";

/**
 * WIR-2143 (T8d): `GET /heartbeat-runs/:runId/workspace-operations` and
 * `GET /workspace-operations/:id/log` must not disclose the operations or log
 * of an execution workspace that belongs to a project hidden from the caller.
 * A Sales-only operator under `enforce` gets the same 404 a random id gets;
 * Sales, project-less and owner reads are unchanged.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat-run workspace-operations routes honour project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-workspace-ops-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(workspaceOperations);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(projectCategories);
    await db.delete(companies);
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
    instance.use("/api", agentRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Run workspace ops visibility ${randomUUID()}`,
      issuePrefix: `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [sales] = await db.insert(projectCategories).values({ companyId, name: "Sales" }).returning();
    const [delivery] = await db.insert(projectCategories).values({ companyId, name: "Delivery" }).returning();
    const [salesProject] = await db.insert(projects).values({ companyId, name: "Sales project", categoryId: sales!.id }).returning();
    const [deliveryProject] = await db.insert(projects).values({ companyId, name: "Delivery project", categoryId: delivery!.id }).returning();

    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Runner",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();

    const workspaceBase = { companyId, mode: "isolated_workspace", strategyType: "git_worktree" };
    async function workspaceWithRun(projectId: string | null, name: string) {
      const [workspace] = await db.insert(executionWorkspaces).values({ ...workspaceBase, projectId, name }).returning();
      const [run] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId: agent!.id,
        scopeKind: "company",
        issueId: null,
        invocationSource: "timer",
        status: "succeeded",
        contextSnapshot: { executionWorkspaceId: workspace!.id },
      }).returning();
      const [operation] = await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId: workspace!.id,
        heartbeatRunId: run!.id,
        phase: "provision",
        status: "succeeded",
        command: `provision ${name}`,
        logStore: "local_file",
        logRef: `missing-${randomUUID()}.ndjson`,
      }).returning();
      return { workspace: workspace!, run: run!, operation: operation! };
    }

    const salesFlow = await workspaceWithRun(salesProject!.id, "Sales workspace");
    const deliveryFlow = await workspaceWithRun(deliveryProject!.id, "Delivery workspace");
    const unboundFlow = await workspaceWithRun(null, "Unbound workspace");

    // A run the Sales operator can see whose operation row points at a Delivery workspace.
    const [crossRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      scopeKind: "company",
      issueId: null,
      invocationSource: "timer",
      status: "succeeded",
      contextSnapshot: {},
    }).returning();
    const [crossOperation] = await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId: deliveryFlow.workspace.id,
      heartbeatRunId: crossRun!.id,
      phase: "provision",
      status: "succeeded",
      command: "provision cross",
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

    return {
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      salesFlow,
      deliveryFlow,
      unboundFlow,
      crossRun: crossRun!,
      crossOperation: crossOperation!,
    };
  }

  // The fixture's log file does not exist, so a reachable operation 404s with a different message.
  function expectLogReachable(res: request.Response) {
    expect(res.body, res.text).not.toEqual({ error: "Workspace operation not found" });
  }

  const listPath = (runId: string) => `/api/heartbeat-runs/${runId}/workspace-operations`;
  const logPath = (operationId: string) => `/api/workspace-operations/${operationId}/log`;

  it("404s a Delivery workspace's run operations exactly like a random id", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    const hidden = await client.get(listPath(fixture.deliveryFlow.run.id));
    const missing = await client.get(listPath(randomUUID()));
    expect(hidden.status, hidden.text).toBe(404);
    expect(hidden.body).toEqual(missing.body);
  });

  it("404s a Delivery workspace's operation log exactly like a random id", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    const hidden = await client.get(logPath(fixture.deliveryFlow.operation.id));
    const missing = await client.get(logPath(randomUUID()));
    expect(hidden.status, hidden.text).toBe(404);
    expect(hidden.body).toEqual(missing.body);
  });

  it("drops a hidden-workspace operation from a run the caller can read", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    const list = await request(app(fixture.salesOperator)).get(listPath(fixture.crossRun.id));
    expect(list.status, list.text).toBe(200);
    expect(list.body).toEqual([]);
  });

  it("404s the log of a hidden-workspace operation attached to a readable run", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    const log = await request(app(fixture.salesOperator)).get(logPath(fixture.crossOperation.id));
    expect(log.status, log.text).toBe(404);
    expect(log.body).toEqual({ error: "Workspace operation not found" });
  });

  it("keeps Sales and project-less workspace operations readable", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    for (const flow of [fixture.salesFlow, fixture.unboundFlow]) {
      const list = await client.get(listPath(flow.run.id));
      expect(list.status, list.text).toBe(200);
      expect(list.body).toEqual([expect.objectContaining({ id: flow.operation.id })]);
      const log = await client.get(logPath(flow.operation.id));
      expectLogReachable(log);
    }
  });

  it("leaves an owner's reads unnarrowed", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.owner));

    const list = await client.get(listPath(fixture.deliveryFlow.run.id));
    expect(list.status, list.text).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ id: fixture.deliveryFlow.operation.id })]);
    const log = await client.get(logPath(fixture.deliveryFlow.operation.id));
    expectLogReachable(log);
  });

  it.each(["off", "shadow"])("does not narrow reads under %s", async (mode) => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    const list = await client.get(listPath(fixture.deliveryFlow.run.id));
    expect(list.status, list.text).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ id: fixture.deliveryFlow.operation.id })]);
    const log = await client.get(logPath(fixture.deliveryFlow.operation.id));
    expectLogReachable(log);
  });
});

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  principalPermissionGrants,
  projectCategories,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

/**
 * WIR-1264 (T8c): a Sales-only operator under `enforce` gets the same 404 for
 * a Delivery project's execution workspace (detail and sub-routes) that a
 * random id gets, and the list and workspace-overview omit it. Workspaces with
 * no project, and Sales workspaces, are unchanged.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("execution workspace routes honour project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspace-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
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
    instance.use("/api", executionWorkspaceRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Workspace visibility ${randomUUID()}`,
      issuePrefix: `W${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [sales] = await db.insert(projectCategories).values({ companyId, name: "Sales" }).returning();
    const [delivery] = await db.insert(projectCategories).values({ companyId, name: "Delivery" }).returning();
    const [salesProject] = await db.insert(projects).values({ companyId, name: "Sales project", categoryId: sales!.id }).returning();
    const [deliveryProject] = await db.insert(projects).values({ companyId, name: "Delivery project", categoryId: delivery!.id }).returning();

    const workspaceBase = { companyId, mode: "isolated_workspace", strategyType: "git_worktree" };
    const [salesWorkspace] = await db.insert(executionWorkspaces)
      .values({ ...workspaceBase, projectId: salesProject!.id, name: "Sales workspace" }).returning();
    const [deliveryWorkspace] = await db.insert(executionWorkspaces)
      .values({ ...workspaceBase, projectId: deliveryProject!.id, name: "Delivery workspace" }).returning();
    const [unboundWorkspace] = await db.insert(executionWorkspaces)
      .values({ ...workspaceBase, projectId: null, name: "Unbound workspace" }).returning();

    const ownerId = `user-${randomUUID()}`;
    const salesOperatorId = `user-${randomUUID()}`;
    const noGrantOperatorId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: salesOperatorId, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: noGrantOperatorId, status: "active", membershipRole: "operator" },
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
      companyId,
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      noGrantOperator: actorFor(companyId, noGrantOperatorId, "operator"),
      deliveryProject: deliveryProject!,
      salesWorkspace: salesWorkspace!,
      deliveryWorkspace: deliveryWorkspace!,
      unboundWorkspace: unboundWorkspace!,
    };
  }

  async function listNames(actor: Express.Request["actor"], companyId: string) {
    const list = await request(app(actor)).get(`/api/companies/${companyId}/execution-workspaces`);
    expect(list.status, list.text).toBe(200);
    const overview = await request(app(actor)).get(`/api/companies/${companyId}/workspace-overview`);
    expect(overview.status, overview.text).toBe(200);
    return {
      list: (list.body as Array<{ name: string }>).map((workspace) => workspace.name).sort(),
      overview: (overview.body.items as Array<{ workspaceName: string }>).map((workspace) => workspace.workspaceName).sort(),
    };
  }

  const ALL_NAMES = ["Delivery workspace", "Sales workspace", "Unbound workspace"];
  const VISIBLE_NAMES = ["Sales workspace", "Unbound workspace"];

  it("404s a Delivery workspace's detail and sub-routes exactly like a random id", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    for (const suffix of ["", "/close-readiness", "/workspace-operations"]) {
      const hidden = await client.get(`/api/execution-workspaces/${fixture.deliveryWorkspace.id}${suffix}`);
      const missing = await client.get(`/api/execution-workspaces/${randomUUID()}${suffix}`);
      expect(hidden.status, hidden.text).toBe(404);
      expect(hidden.body).toEqual({ error: "Execution workspace not found" });
      expect(hidden.body).toEqual(missing.body);
    }
  });

  it("omits only the Delivery workspace from the list and workspace-overview", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    expect(await listNames(fixture.salesOperator, fixture.companyId)).toEqual({
      list: VISIBLE_NAMES,
      overview: VISIBLE_NAMES,
    });
  });

  it("keeps Sales and project-less workspaces readable", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    for (const workspace of [fixture.salesWorkspace, fixture.unboundWorkspace]) {
      for (const suffix of ["", "/close-readiness", "/workspace-operations"]) {
        const res = await client.get(`/api/execution-workspaces/${workspace.id}${suffix}`);
        expect(res.status, `${suffix}: ${res.text}`).toBe(200);
      }
    }
  });

  it("404s a hidden workspace on write routes without confirming it exists", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    const hidden = await client.patch(`/api/execution-workspaces/${fixture.deliveryWorkspace.id}`).send({ name: "x" });
    const missing = await client.patch(`/api/execution-workspaces/${randomUUID()}`).send({ name: "x" });
    expect(hidden.status, hidden.text).toBe(404);
    expect(hidden.body).toEqual(missing.body);
  });

  it("applies the same predicate to ?summary=true and the ?projectId filter", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));
    const base = `/api/companies/${fixture.companyId}/execution-workspaces`;

    const summary = await client.get(`${base}?summary=true`);
    expect(summary.status, summary.text).toBe(200);
    expect((summary.body as Array<{ name: string }>).map((workspace) => workspace.name).sort()).toEqual(VISIBLE_NAMES);

    const filtered = await client.get(`${base}?projectId=${fixture.deliveryProject.id}`);
    expect(filtered.status, filtered.text).toBe(200);
    expect(filtered.body).toEqual([]);

    const overview = await client.get(
      `/api/companies/${fixture.companyId}/workspace-overview?projectId=${fixture.deliveryProject.id}`,
    );
    expect(overview.status, overview.text).toBe(200);
    expect(overview.body.items).toEqual([]);
  });

  it("shows an operator with no projects:access grant only project-less workspaces", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    expect(await listNames(fixture.noGrantOperator, fixture.companyId)).toEqual({
      list: ["Unbound workspace"],
      overview: ["Unbound workspace"],
    });
    const hidden = await request(app(fixture.noGrantOperator)).get(`/api/execution-workspaces/${fixture.salesWorkspace.id}`);
    expect(hidden.status, hidden.text).toBe(404);
  });

  it("leaves an owner's list, overview and detail unnarrowed", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    expect(await listNames(fixture.owner, fixture.companyId)).toEqual({ list: ALL_NAMES, overview: ALL_NAMES });
    const detail = await request(app(fixture.owner)).get(`/api/execution-workspaces/${fixture.deliveryWorkspace.id}`);
    expect(detail.status, detail.text).toBe(200);
  });

  it.each(["shadow", "off"])("does not hide the Delivery workspace in %s mode", async (mode) => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
    const fixture = await seed();

    expect(await listNames(fixture.salesOperator, fixture.companyId)).toEqual({ list: ALL_NAMES, overview: ALL_NAMES });
    const detail = await request(app(fixture.salesOperator)).get(`/api/execution-workspaces/${fixture.deliveryWorkspace.id}`);
    expect(detail.status, detail.text).toBe(200);
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  projectCategories,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { projectRoutes } from "../routes/projects.js";
import { isProjectHiddenByProjectVisibility } from "../routes/authz.js";

/**
 * WIR-1383: under `enforce`, every project mutation route answers a project
 * the actor cannot see with the same 404 a random id gets, and changes
 * nothing. Visible projects, owners, `shadow` and `off` are unaffected.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

type Actor = Express.Request["actor"];

describeEmbeddedPostgres("project mutation routes honour project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-mutation-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(activityLog);
    await db.delete(projectWorkspaces);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(projectCategories);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function actorFor(companyId: string, userId: string, membershipRole: string): Actor {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole }],
    } as Actor;
  }

  function app(actor: Actor) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", projectRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Project mutation visibility ${randomUUID()}`,
      issuePrefix: `M${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [sales] = await db.insert(projectCategories).values({ companyId, name: "Sales" }).returning();
    const [delivery] = await db.insert(projectCategories).values({ companyId, name: "Delivery" }).returning();
    const [salesProject] = await db.insert(projects).values({ companyId, name: "Sales project", categoryId: sales!.id }).returning();
    const [deliveryProject] = await db.insert(projects).values({ companyId, name: "Delivery project", categoryId: delivery!.id }).returning();
    const [salesWorkspace] = await db.insert(projectWorkspaces).values({
      companyId, projectId: salesProject!.id, name: "Sales repo", repoUrl: "https://github.com/acme/sales",
    }).returning();
    const [deliveryWorkspace] = await db.insert(projectWorkspaces).values({
      companyId, projectId: deliveryProject!.id, name: "Delivery repo", repoUrl: "https://github.com/acme/delivery",
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
      companyId,
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      salesProject: salesProject!,
      deliveryProject: deliveryProject!,
      salesWorkspace: salesWorkspace!,
      deliveryWorkspace: deliveryWorkspace!,
    };
  }

  type Mutation = {
    name: string;
    send: (client: ReturnType<typeof request>, projectId: string, workspaceId: string) => Promise<request.Response>;
  };

  const mutations: Mutation[] = [
    {
      name: "PATCH /projects/:id",
      send: (client, projectId) => client.patch(`/api/projects/${projectId}`).send({ name: "Renamed" }),
    },
    {
      name: "PUT /projects/:id/repositories",
      send: (client, projectId) => client.put(`/api/projects/${projectId}/repositories`).send({ repositoryIds: [] }),
    },
    {
      name: "POST /projects/:id/workspaces",
      send: (client, projectId) =>
        client.post(`/api/projects/${projectId}/workspaces`).send({ name: "New repo", repoUrl: "https://github.com/acme/new" }),
    },
    {
      name: "PATCH /projects/:id/workspaces/:workspaceId",
      send: (client, projectId, workspaceId) =>
        client.patch(`/api/projects/${projectId}/workspaces/${workspaceId}`).send({ name: "Renamed repo" }),
    },
    {
      name: "POST /projects/:id/workspaces/:workspaceId/runtime-services/:action",
      send: (client, projectId, workspaceId) =>
        client.post(`/api/projects/${projectId}/workspaces/${workspaceId}/runtime-services/stop`).send({}),
    },
    {
      name: "POST /projects/:id/workspaces/:workspaceId/runtime-commands/:action",
      send: (client, projectId, workspaceId) =>
        client.post(`/api/projects/${projectId}/workspaces/${workspaceId}/runtime-commands/stop`).send({}),
    },
    {
      name: "DELETE /projects/:id/workspaces/:workspaceId",
      send: (client, projectId, workspaceId) => client.delete(`/api/projects/${projectId}/workspaces/${workspaceId}`),
    },
    {
      name: "DELETE /projects/:id",
      send: (client, projectId) => client.delete(`/api/projects/${projectId}`),
    },
  ];

  async function snapshot(projectId: string) {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    const workspaces = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.projectId, projectId));
    return {
      project,
      workspaces: workspaces.map((workspace) => ({ ...workspace })).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  it.each(mutations)("$name 404s a hidden project like a random id and changes nothing", async ({ send }) => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));
    const before = await snapshot(fixture.deliveryProject.id);

    const hidden = await send(client, fixture.deliveryProject.id, fixture.deliveryWorkspace.id);
    const missing = await send(client, randomUUID(), randomUUID());

    expect(hidden.status, hidden.text).toBe(404);
    expect(hidden.body).toEqual({ error: "Project not found" });
    expect(missing.status, missing.text).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(await snapshot(fixture.deliveryProject.id)).toEqual(before);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("lets the same operator mutate a visible project through every route", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));
    const projectId = fixture.salesProject.id;

    const patched = await client.patch(`/api/projects/${projectId}`).send({ name: "Renamed" });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.name).toBe("Renamed");

    const created = await client.post(`/api/projects/${projectId}/workspaces`)
      .send({ name: "New repo", repoUrl: "https://github.com/acme/new" });
    expect(created.status, created.text).toBe(201);

    const patchedWorkspace = await client.patch(`/api/projects/${projectId}/workspaces/${created.body.id}`)
      .send({ name: "Renamed repo" });
    expect(patchedWorkspace.status, patchedWorkspace.text).toBe(200);

    // A visible project gets past the gate: the handlers reach their own
    // workspace lookup instead of answering "Project not found".
    for (const route of ["runtime-services", "runtime-commands"]) {
      const runtime = await client.post(`/api/projects/${projectId}/workspaces/${randomUUID()}/${route}/stop`).send({});
      expect(runtime.status, runtime.text).toBe(404);
      expect(runtime.body).toEqual({ error: "Project workspace not found" });
    }

    const deletedWorkspace = await client.delete(`/api/projects/${projectId}/workspaces/${created.body.id}`);
    expect(deletedWorkspace.status, deletedWorkspace.text).toBe(200);

    const repositories = await client.put(`/api/projects/${projectId}/repositories`).send({ repositoryIds: [] });
    expect(repositories.status, repositories.text).toBe(200);

    const deleted = await client.delete(`/api/projects/${projectId}`);
    expect(deleted.status, deleted.text).toBe(200);
    expect((await snapshot(projectId)).project).toBeUndefined();
  });

  it("leaves an owner able to mutate the Delivery project", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.owner));

    const patched = await client.patch(`/api/projects/${fixture.deliveryProject.id}`).send({ name: "Renamed" });
    expect(patched.status, patched.text).toBe(200);
    const deleted = await client.delete(`/api/projects/${fixture.deliveryProject.id}`);
    expect(deleted.status, deleted.text).toBe(200);
  });

  it.each(["shadow", "off"])("does not hide the Delivery project from mutation in %s mode", async (mode) => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    const patched = await client.patch(`/api/projects/${fixture.deliveryProject.id}`).send({ name: "Renamed" });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.name).toBe("Renamed");
    const deletedWorkspace = await client.delete(
      `/api/projects/${fixture.deliveryProject.id}/workspaces/${fixture.deliveryWorkspace.id}`,
    );
    expect(deletedWorkspace.status, deletedWorkspace.text).toBe(200);
  });
});

describe("isProjectHiddenByProjectVisibility", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("makes no authorization query in off mode", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
    const decide = vi.fn();
    const req = { actor: { type: "board", userId: "user-1", source: "session" } } as unknown as express.Request;

    await expect(isProjectHiddenByProjectVisibility(req, { decide }, { id: randomUUID(), companyId: randomUUID() }))
      .resolves.toBe(false);
    expect(decide).not.toHaveBeenCalled();
  });

  it("treats only a visibility denial as hidden", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const req = { actor: { type: "board", userId: "user-1", source: "session" } } as unknown as express.Request;
    const project = { id: randomUUID(), companyId: randomUUID() };

    await expect(isProjectHiddenByProjectVisibility(
      req,
      { decide: async () => ({ allowed: false, reason: "deny_project_visibility" }) },
      project,
    )).resolves.toBe(true);
    await expect(isProjectHiddenByProjectVisibility(
      req,
      { decide: async () => ({ allowed: false, reason: "deny_missing_membership" }) },
      project,
    )).resolves.toBe(false);
  });
});

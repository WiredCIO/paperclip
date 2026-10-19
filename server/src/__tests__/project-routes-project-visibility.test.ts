import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  projectCategories,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { projectRoutes } from "../routes/projects.js";

/**
 * WIR-1262 (T8a): a Sales-only operator under `enforce` gets the same 404 for
 * a Delivery project's detail and external-object summary that a random id
 * gets, and the company project list omits it.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("project routes honour project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-routes-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
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
    instance.use("/api", projectRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Project visibility ${randomUUID()}`,
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [sales] = await db.insert(projectCategories).values({ companyId, name: "Sales" }).returning();
    const [delivery] = await db.insert(projectCategories).values({ companyId, name: "Delivery" }).returning();
    const [salesProject] = await db.insert(projects).values({ companyId, name: "Sales project", categoryId: sales!.id }).returning();
    const [deliveryProject] = await db.insert(projects).values({ companyId, name: "Delivery project", categoryId: delivery!.id }).returning();
    const [grantedProject] = await db.insert(projects).values({ companyId, name: "Granted project" }).returning();

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
      scope: { categoryIds: [sales!.id], projectIds: [grantedProject!.id] },
      grantedByUserId: null,
    });

    return {
      companyId,
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      salesProject: salesProject!,
      deliveryProject: deliveryProject!,
      grantedProject: grantedProject!,
    };
  }

  async function listNames(actor: Express.Request["actor"], companyId: string) {
    const res = await request(app(actor)).get(`/api/companies/${companyId}/projects`);
    expect(res.status, res.text).toBe(200);
    return (res.body as Array<{ name: string }>).map((project) => project.name).sort();
  }

  it("404s a Delivery project's detail and external-object summary exactly like a random id", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    for (const suffix of ["", "/external-object-summary"]) {
      const hidden = await client.get(`/api/projects/${fixture.deliveryProject.id}${suffix}`);
      const missing = await client.get(`/api/projects/${randomUUID()}${suffix}`);
      expect(hidden.status, hidden.text).toBe(404);
      expect(hidden.body).toEqual({ error: "Project not found" });
      expect(hidden.body).toEqual(missing.body);
    }
  });

  it("keeps visible projects readable and omits only the Delivery project from the list", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    for (const project of [fixture.salesProject, fixture.grantedProject]) {
      const detail = await client.get(`/api/projects/${project.id}`);
      expect(detail.status, detail.text).toBe(200);
      expect(detail.body.id).toBe(project.id);
      const summary = await client.get(`/api/projects/${project.id}/external-object-summary`);
      expect(summary.status, summary.text).toBe(200);
    }

    expect(await listNames(fixture.salesOperator, fixture.companyId)).toEqual(["Granted project", "Sales project"]);
  });

  it("leaves an owner's list, detail and summary unnarrowed", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const client = request(app(fixture.owner));

    expect(await listNames(fixture.owner, fixture.companyId)).toEqual([
      "Delivery project",
      "Granted project",
      "Sales project",
    ]);
    const detail = await client.get(`/api/projects/${fixture.deliveryProject.id}`);
    expect(detail.status, detail.text).toBe(200);
    const summary = await client.get(`/api/projects/${fixture.deliveryProject.id}/external-object-summary`);
    expect(summary.status, summary.text).toBe(200);
  });

  it.each(["shadow", "off"])("does not hide the Delivery project in %s mode", async (mode) => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
    const fixture = await seed();
    const client = request(app(fixture.salesOperator));

    expect(await listNames(fixture.salesOperator, fixture.companyId)).toEqual([
      "Delivery project",
      "Granted project",
      "Sales project",
    ]);
    const detail = await client.get(`/api/projects/${fixture.deliveryProject.id}`);
    expect(detail.status, detail.text).toBe(200);
    const summary = await client.get(`/api/projects/${fixture.deliveryProject.id}/external-object-summary`);
    expect(summary.status, summary.text).toBe(200);
  });

  it("still 403s a non-visibility read denial on the external-object summary", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    // A board user whose session lists the company but who holds no active
    // membership: the read is denied for a reason other than visibility.
    const outsiderId = `user-${randomUUID()}`;
    const outsider = actorFor(fixture.companyId, outsiderId, "operator");

    const summary = await request(app(outsider)).get(`/api/projects/${fixture.salesProject.id}/external-object-summary`);
    expect(summary.status, summary.text).toBe(403);
    expect(summary.body).toEqual({ error: "Project is outside this actor's authorization boundary" });
  });
});

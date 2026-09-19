import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  projectBindings,
  projectCategories,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { projectAccessRoutes } from "../routes/project-access.js";
import { projectRoutes } from "../routes/projects.js";
import { projectService } from "../services/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function boardActor(companyId: string, userId: string, membershipRole: string) {
  return {
    type: "board" as const,
    source: "session" as const,
    userId,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active" as const, membershipRole }],
  };
}

function appFor(db: Db, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectAccessRoutes(db));
  app.use(errorHandler);
  return app;
}

function projectsAppFor(db: Db, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("project-access routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-access-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectBindings);
    await db.delete(principalPermissionGrants);
    await db.delete(projects);
    await db.delete(projectCategories);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(label: string) {
    return db
      .insert(companies)
      .values({ name: `Access ${label}`, issuePrefix: `PA${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedMember(companyId: string, membershipRole: string) {
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole });
    return userId;
  }

  async function seedProject(companyId: string, name = `Project ${randomUUID()}`) {
    return db.insert(projects).values({ companyId, name }).returning().then((rows) => rows[0]!);
  }

  async function seedAgent(companyId: string) {
    return db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  describe("project categories", () => {
    it("creates, lists, updates and deletes a category, nulling category_id on delete", async () => {
      const company = await seedCompany("Categories");
      const ownerId = await seedMember(company.id, "owner");
      const app = appFor(db, boardActor(company.id, ownerId, "owner"));

      const createRes = await request(app)
        .post(`/api/companies/${company.id}/project-categories`)
        .send({ name: "Engineering" });
      expect(createRes.status).toBe(201);
      expect(createRes.body.name).toBe("Engineering");

      const listRes = await request(app).get(`/api/companies/${company.id}/project-categories`);
      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveLength(1);

      const categoryId = createRes.body.id as string;
      const updateRes = await request(app)
        .patch(`/api/project-categories/${categoryId}`)
        .send({ name: "Eng" });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.name).toBe("Eng");

      const project = await seedProject(company.id);
      await db.update(projects).set({ categoryId }).where(eq(projects.id, project.id));

      const deleteRes = await request(app).delete(`/api/project-categories/${categoryId}`);
      expect(deleteRes.status).toBe(200);

      const [refreshedProject] = await db.select().from(projects).where(eq(projects.id, project.id));
      expect(refreshedProject?.categoryId).toBeNull();
    });

    it("rejects a duplicate category name with 409", async () => {
      const company = await seedCompany("Duplicate");
      const ownerId = await seedMember(company.id, "owner");
      const app = appFor(db, boardActor(company.id, ownerId, "owner"));

      await request(app).post(`/api/companies/${company.id}/project-categories`).send({ name: "Ops" });
      const dupe = await request(app).post(`/api/companies/${company.id}/project-categories`).send({ name: "Ops" });
      expect(dupe.status).toBe(409);
    });

    it("404s on a cross-company category id without leaking existence", async () => {
      const companyA = await seedCompany("A");
      const companyB = await seedCompany("B");
      const ownerA = await seedMember(companyA.id, "owner");
      await seedMember(companyB.id, "owner");
      const appA = appFor(db, boardActor(companyA.id, ownerA, "owner"));

      const created = await db
        .insert(projectCategories)
        .values({ companyId: companyB.id, name: "Only in B" })
        .returning()
        .then((rows) => rows[0]!);

      const patchRes = await request(appA).patch(`/api/project-categories/${created.id}`).send({ name: "Hijacked" });
      expect(patchRes.status).toBe(404);

      const missingRes = await request(appA).patch(`/api/project-categories/${randomUUID()}`).send({ name: "Nope" });
      expect(missingRes.status).toBe(404);
      expect(missingRes.body.error).toBe(patchRes.body.error);
    });

    it("rejects a non-owner/admin member with 403", async () => {
      const company = await seedCompany("Operator");
      const operatorId = await seedMember(company.id, "operator");
      const app = appFor(db, boardActor(company.id, operatorId, "operator"));

      const res = await request(app).post(`/api/companies/${company.id}/project-categories`).send({ name: "Nope" });
      expect(res.status).toBe(403);
    });
  });

  describe("project bindings", () => {
    it("replaces the binding set idempotently and validates in-company target ids", async () => {
      const company = await seedCompany("Bindings");
      const ownerId = await seedMember(company.id, "owner");
      const app = appFor(db, boardActor(company.id, ownerId, "owner"));
      const project = await seedProject(company.id);
      const agent = await seedAgent(company.id);

      const putRes = await request(app)
        .put(`/api/companies/${company.id}/project-bindings`)
        .send({ bindings: [{ projectId: project.id, targetType: "agent", targetId: agent.id }] });
      expect(putRes.status).toBe(200);
      expect(putRes.body.bindings).toHaveLength(1);

      const repeatRes = await request(app)
        .put(`/api/companies/${company.id}/project-bindings`)
        .send({ bindings: [{ projectId: project.id, targetType: "agent", targetId: agent.id }] });
      expect(repeatRes.status).toBe(200);
      expect(repeatRes.body.bindings).toHaveLength(1);
      expect(repeatRes.body.bindings[0].id).toBe(putRes.body.bindings[0].id);

      const clearRes = await request(app)
        .put(`/api/companies/${company.id}/project-bindings`)
        .send({ bindings: [] });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.bindings).toHaveLength(0);
    });

    it("422s on a cross-company project id or target id", async () => {
      const companyA = await seedCompany("BindA");
      const companyB = await seedCompany("BindB");
      const ownerA = await seedMember(companyA.id, "owner");
      const app = appFor(db, boardActor(companyA.id, ownerA, "owner"));
      const projectB = await seedProject(companyB.id);
      const agentB = await seedAgent(companyB.id);
      const projectA = await seedProject(companyA.id);

      const crossProjectRes = await request(app)
        .put(`/api/companies/${companyA.id}/project-bindings`)
        .send({ bindings: [{ projectId: projectB.id, targetType: "agent", targetId: agentB.id }] });
      expect(crossProjectRes.status).toBe(422);

      const crossTargetRes = await request(app)
        .put(`/api/companies/${companyA.id}/project-bindings`)
        .send({ bindings: [{ projectId: projectA.id, targetType: "agent", targetId: agentB.id }] });
      expect(crossTargetRes.status).toBe(422);
    });

    it("cascades bindings when the bound project is deleted", async () => {
      const company = await seedCompany("Cascade");
      const project = await seedProject(company.id);
      const agent = await seedAgent(company.id);
      await db.insert(projectBindings).values({
        companyId: company.id,
        projectId: project.id,
        targetType: "agent",
        targetId: agent.id,
        createdByUserId: "user-1",
      });

      await db.delete(projects).where(eq(projects.id, project.id));

      const remaining = await db.select().from(projectBindings).where(eq(projectBindings.companyId, company.id));
      expect(remaining).toHaveLength(0);
    });
  });

  describe("project access grants", () => {
    it("is idempotent on repeated PUTs and readable via GET", async () => {
      const company = await seedCompany("Grants");
      const ownerId = await seedMember(company.id, "owner");
      const memberId = await seedMember(company.id, "operator");
      const app = appFor(db, boardActor(company.id, ownerId, "owner"));

      const firstPut = await request(app)
        .put(`/api/companies/${company.id}/members/${memberId}/project-access`)
        .send({ scope: null });
      expect(firstPut.status).toBe(200);
      expect(firstPut.body.scope).toBeNull();

      const secondPut = await request(app)
        .put(`/api/companies/${company.id}/members/${memberId}/project-access`)
        .send({ scope: null });
      expect(secondPut.status).toBe(200);

      const rows = await db
        .select()
        .from(principalPermissionGrants)
        .where(eq(principalPermissionGrants.principalId, memberId));
      expect(rows).toHaveLength(1);

      const getRes = await request(app).get(`/api/companies/${company.id}/members/${memberId}/project-access`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.grant.scope).toBeNull();
    });

    it("accepts a scoped grant and validates category/project ids belong to the company", async () => {
      const company = await seedCompany("ScopedGrants");
      const ownerId = await seedMember(company.id, "owner");
      const memberId = await seedMember(company.id, "operator");
      const app = appFor(db, boardActor(company.id, ownerId, "owner"));
      const category = await db
        .insert(projectCategories)
        .values({ companyId: company.id, name: "Client Work" })
        .returning()
        .then((rows) => rows[0]!);

      const res = await request(app)
        .put(`/api/companies/${company.id}/members/${memberId}/project-access`)
        .send({ scope: { categoryIds: [category.id] } });
      expect(res.status).toBe(200);
      expect(res.body.scope).toEqual({ categoryIds: [category.id] });

      const badRes = await request(app)
        .put(`/api/companies/${company.id}/members/${memberId}/project-access`)
        .send({ scope: { categoryIds: [randomUUID()] } });
      expect(badRes.status).toBe(422);
    });

    it("deletes a grant, and 404s for a user outside the company", async () => {
      const companyA = await seedCompany("DeleteA");
      const companyB = await seedCompany("DeleteB");
      const ownerA = await seedMember(companyA.id, "owner");
      const memberA = await seedMember(companyA.id, "operator");
      const memberB = await seedMember(companyB.id, "operator");
      const app = appFor(db, boardActor(companyA.id, ownerA, "owner"));

      await request(app).put(`/api/companies/${companyA.id}/members/${memberA}/project-access`).send({ scope: null });

      const crossRes = await request(app)
        .put(`/api/companies/${companyA.id}/members/${memberB}/project-access`)
        .send({ scope: null });
      expect(crossRes.status).toBe(404);

      const deleteRes = await request(app).delete(`/api/companies/${companyA.id}/members/${memberA}/project-access`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.deleted).toBe(true);

      const rows = await db
        .select()
        .from(principalPermissionGrants)
        .where(eq(principalPermissionGrants.principalId, memberA));
      expect(rows).toHaveLength(0);
    });
  });

  describe("POST /companies/:id/projects categoryId", () => {
    it("403s a non-owner/admin member at the route level, and allows an owner", async () => {
      const company = await seedCompany("CreateAuthz");
      const category = await db
        .insert(projectCategories)
        .values({ companyId: company.id, name: "Create-time" })
        .returning()
        .then((rows) => rows[0]!);

      const memberId = await seedMember(company.id, "member");
      const memberApp = projectsAppFor(db, boardActor(company.id, memberId, "member"));
      const denied = await request(memberApp)
        .post(`/api/companies/${company.id}/projects`)
        .send({ name: "Member project", categoryId: category.id });
      expect(denied.status).toBe(403);

      const [projectRows] = await db.select().from(projects).where(eq(projects.companyId, company.id));
      expect(projectRows).toBeUndefined();

      const ownerId = await seedMember(company.id, "owner");
      const ownerApp = projectsAppFor(db, boardActor(company.id, ownerId, "owner"));
      const allowed = await request(ownerApp)
        .post(`/api/companies/${company.id}/projects`)
        .send({ name: "Owner project", categoryId: category.id });
      expect(allowed.status).toBe(201);
      expect(allowed.body.categoryId).toBe(category.id);
    });
  });

  describe("PATCH /projects/:id categoryId", () => {
    it("validates the categoryId belongs to the project's own company", async () => {
      const companyA = await seedCompany("PatchA");
      const companyB = await seedCompany("PatchB");
      const project = await seedProject(companyA.id);
      const categoryB = await db
        .insert(projectCategories)
        .values({ companyId: companyB.id, name: "Other company" })
        .returning()
        .then((rows) => rows[0]!);

      const svc = projectService(db);
      await expect(svc.update(project.id, { categoryId: categoryB.id })).rejects.toThrow();

      const categoryA = await db
        .insert(projectCategories)
        .values({ companyId: companyA.id, name: "Same company" })
        .returning()
        .then((rows) => rows[0]!);
      const updated = await svc.update(project.id, { categoryId: categoryA.id });
      expect(updated?.categoryId).toBe(categoryA.id);
    });

    it("403s a non-owner/admin member at the route level, and allows an owner", async () => {
      const company = await seedCompany("PatchAuthz");
      const project = await seedProject(company.id);
      const category = await db
        .insert(projectCategories)
        .values({ companyId: company.id, name: "Route level" })
        .returning()
        .then((rows) => rows[0]!);

      const memberId = await seedMember(company.id, "member");
      const memberApp = projectsAppFor(db, boardActor(company.id, memberId, "member"));
      const denied = await request(memberApp).patch(`/api/projects/${project.id}`).send({ categoryId: category.id });
      expect(denied.status).toBe(403);

      const [untouched] = await db.select().from(projects).where(eq(projects.id, project.id));
      expect(untouched?.categoryId).toBeNull();

      const ownerId = await seedMember(company.id, "owner");
      const ownerApp = projectsAppFor(db, boardActor(company.id, ownerId, "owner"));
      const allowed = await request(ownerApp).patch(`/api/projects/${project.id}`).send({ categoryId: category.id });
      expect(allowed.status).toBe(200);
      expect(allowed.body.categoryId).toBe(category.id);
    });
  });
});

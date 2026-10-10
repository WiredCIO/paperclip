import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
  principalPermissionGrants,
  projectBindings,
  projectCategories,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import {
  authorizationService,
  type AuthorizationAction,
  type AuthorizationActor,
  type AuthorizationResource,
} from "../services/authorization.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({ name: `Project visibility authz ${randomUUID()}`, issuePrefix: `PA${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createMember(db: Db, companyId: string, membershipRole: string, userId = `user-${randomUUID()}`) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole,
  });
  return userId;
}

async function grantProjectsAccess(db: Db, companyId: string, userId: string, scope: Record<string, unknown> | null) {
  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "user",
    principalId: userId,
    permissionKey: "projects:access",
    scope,
    grantedByUserId: null,
  });
}

async function createProject(db: Db, companyId: string, categoryId: string | null) {
  return db
    .insert(projects)
    .values({ companyId, name: `Project ${randomUUID()}`, categoryId })
    .returning()
    .then((rows) => rows[0]!);
}

async function createIssue(db: Db, companyId: string, projectId: string | null) {
  return db
    .insert(issues)
    .values({ companyId, title: `Issue ${randomUUID()}`, status: "todo", priority: "medium", projectId })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string, boundProjectId: string | null) {
  const agent = await db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      permissions: {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
  if (boundProjectId) {
    await db.insert(projectBindings).values({
      companyId,
      projectId: boundProjectId,
      targetType: "agent",
      targetId: agent.id,
      createdByUserId: "test",
    });
  }
  return agent;
}

function issueResource(issue: { id: string; companyId: string; projectId: string | null }): AuthorizationResource {
  return {
    type: "issue",
    companyId: issue.companyId,
    issueId: issue.id,
    projectId: issue.projectId,
    parentIssueId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    status: "todo",
  };
}

describeEmbeddedPostgres("project visibility in decideBase", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let fixture!: Awaited<ReturnType<typeof seed>>;

  async function seed() {
    const company = await createCompany(db);
    const sales = await db.insert(projectCategories).values({ companyId: company.id, name: "Sales" }).returning().then((r) => r[0]!);
    const delivery = await db.insert(projectCategories).values({ companyId: company.id, name: "Delivery" }).returning().then((r) => r[0]!);
    const salesProject = await createProject(db, company.id, sales.id);
    const deliveryProject = await createProject(db, company.id, delivery.id);

    const ownerId = await createMember(db, company.id, "owner");
    const adminId = await createMember(db, company.id, "admin");
    const orgOperatorId = await createMember(db, company.id, "operator");
    await grantProjectsAccess(db, company.id, orgOperatorId, null);
    const salesOperatorId = await createMember(db, company.id, "operator");
    await grantProjectsAccess(db, company.id, salesOperatorId, { categoryIds: [sales.id] });

    return {
      company,
      salesProject,
      deliveryProject,
      salesIssue: await createIssue(db, company.id, salesProject.id),
      deliveryIssue: await createIssue(db, company.id, deliveryProject.id),
      unboundIssue: await createIssue(db, company.id, null),
      salesAgent: await createAgent(db, company.id, salesProject.id),
      deliveryAgent: await createAgent(db, company.id, deliveryProject.id),
      unboundAgent: await createAgent(db, company.id, null),
      ownerId,
      adminId,
      orgOperatorId,
      salesOperatorId,
    };
  }

  function sessionActor(userId: string): AuthorizationActor {
    return { type: "board", userId, source: "session" };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-authz-project-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    fixture = await seed();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await db.delete(projectBindings);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(projectCategories);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("sales-only operator under enforce", () => {
    beforeEach(() => {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    });

    async function decide(action: AuthorizationAction, resource: AuthorizationResource) {
      return authorizationService(db).decide({ actor: sessionActor(fixture.salesOperatorId), action, resource });
    }

    it("denies issue:read on a Delivery issue and allows unbound and Sales issues", async () => {
      await expect(decide("issue:read", issueResource(fixture.deliveryIssue))).resolves.toMatchObject({
        allowed: false,
        reason: "deny_project_visibility",
      });
      await expect(decide("issue:read", issueResource(fixture.unboundIssue))).resolves.toMatchObject({
        allowed: true,
        reason: "allow_simple_company_member",
      });
      await expect(decide("issue:read", issueResource(fixture.salesIssue))).resolves.toMatchObject({
        allowed: true,
        reason: "allow_simple_company_member",
      });
    });

    it("looks up the issue's project when the resource omits projectId", async () => {
      await expect(decide("issue:read", {
        type: "issue",
        companyId: fixture.company.id,
        issueId: fixture.deliveryIssue.id,
      })).resolves.toMatchObject({ allowed: false, reason: "deny_project_visibility" });
    });

    it("denies project:read on a Delivery project and allows a Sales project", async () => {
      await expect(decide("project:read", {
        type: "project",
        companyId: fixture.company.id,
        projectId: fixture.deliveryProject.id,
      })).resolves.toMatchObject({ allowed: false, reason: "deny_project_visibility" });
      await expect(decide("project:read", {
        type: "project",
        companyId: fixture.company.id,
        projectId: fixture.salesProject.id,
      })).resolves.toMatchObject({ allowed: true });
    });

    it("denies agent:read on a Delivery-bound agent and allows unbound and Sales-bound agents", async () => {
      const agentResource = (agentId: string): AuthorizationResource => ({
        type: "agent",
        companyId: fixture.company.id,
        agentId,
      });
      await expect(decide("agent:read", agentResource(fixture.deliveryAgent.id))).resolves.toMatchObject({
        allowed: false,
        reason: "deny_project_visibility",
      });
      await expect(decide("agent:read", agentResource(fixture.unboundAgent.id))).resolves.toMatchObject({
        allowed: true,
      });
      await expect(decide("agent:read", agentResource(fixture.salesAgent.id))).resolves.toMatchObject({
        allowed: true,
      });
    });

    it("keeps company_scope:read allowed", async () => {
      await expect(decide("company_scope:read", { type: "company", companyId: fixture.company.id }))
        .resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    });

    it("does not reuse one company's visibility for another company on the same actor object", async () => {
      const otherCompany = await createCompany(db);
      await createMember(db, otherCompany.id, "operator", fixture.salesOperatorId);
      await grantProjectsAccess(db, otherCompany.id, fixture.salesOperatorId, null);
      const otherProject = await createProject(db, otherCompany.id, null);
      const otherIssue = await createIssue(db, otherCompany.id, otherProject.id);

      const actor = sessionActor(fixture.salesOperatorId);
      const authz = authorizationService(db);
      await expect(authz.decide({ actor, action: "issue:read", resource: issueResource(fixture.deliveryIssue) }))
        .resolves.toMatchObject({ allowed: false });
      await expect(authz.decide({ actor, action: "issue:read", resource: issueResource(otherIssue) }))
        .resolves.toMatchObject({ allowed: true });
    });
  });

  describe("shadow and off modes", () => {
    it("shadow allows the would-be deny and logs it", async () => {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "shadow");
      const info = vi.spyOn(logger, "info");
      const decision = await authorizationService(db).decide({
        actor: sessionActor(fixture.salesOperatorId),
        action: "issue:read",
        resource: issueResource(fixture.deliveryIssue),
      });
      expect(decision).toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ event: "project_visibility_shadow_deny", action: "issue:read", resourceType: "issue" }),
        expect.any(String),
      );
    });

    it("off allows without logging", async () => {
      vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
      const info = vi.spyOn(logger, "info");
      const decision = await authorizationService(db).decide({
        actor: sessionActor(fixture.salesOperatorId),
        action: "issue:read",
        resource: issueResource(fixture.deliveryIssue),
      });
      expect(decision).toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
      expect(info).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "project_visibility_shadow_deny" }),
        expect.any(String),
      );
    });
  });

  /**
   * Regression table: every decision for unrestricted actors must match the
   * pre-change snapshot below in every mode. The expected values were recorded
   * against authorization.ts before the project-visibility hook was added.
   */
  describe("unrestricted actors are unchanged in every mode", () => {
    type Row = [string, AuthorizationAction, string, boolean, string];
    const actors = ["owner", "admin", "orgOperator", "localImplicit", "salesOperatorBaseline"] as const;

    function actorFor(name: (typeof actors)[number]): AuthorizationActor {
      if (name === "localImplicit") return { type: "board", userId: "local-board", source: "local_implicit" };
      if (name === "owner") return sessionActor(fixture.ownerId);
      if (name === "admin") return sessionActor(fixture.adminId);
      if (name === "orgOperator") return sessionActor(fixture.orgOperatorId);
      return sessionActor(fixture.salesOperatorId);
    }

    function resourceFor(name: string): AuthorizationResource {
      const companyId = fixture.company.id;
      switch (name) {
        case "deliveryIssue": return issueResource(fixture.deliveryIssue);
        case "salesIssue": return issueResource(fixture.salesIssue);
        case "unboundIssue": return issueResource(fixture.unboundIssue);
        case "deliveryProject": return { type: "project", companyId, projectId: fixture.deliveryProject.id };
        case "salesProject": return { type: "project", companyId, projectId: fixture.salesProject.id };
        case "deliveryAgent": return { type: "agent", companyId, agentId: fixture.deliveryAgent.id };
        case "unboundAgent": return { type: "agent", companyId, agentId: fixture.unboundAgent.id };
        case "company": return { type: "company", companyId };
        default: throw new Error(`unknown resource ${name}`);
      }
    }

    const cases: Array<[AuthorizationAction, string]> = [
      ["issue:read", "deliveryIssue"],
      ["issue:read", "salesIssue"],
      ["issue:read", "unboundIssue"],
      ["issue:mutate", "deliveryIssue"],
      ["issue:comment", "deliveryIssue"],
      ["project:read", "deliveryProject"],
      ["project:read", "salesProject"],
      ["agent:read", "deliveryAgent"],
      ["agent:read", "unboundAgent"],
      ["company_scope:read", "company"],
    ];

    const snapshot: Record<(typeof actors)[number], Row[]> = {
      owner: cases.map(([action, resource]) => ["owner", action, resource, true, "allow_simple_company_member"]),
      admin: cases.map(([action, resource]) => ["admin", action, resource, true, "allow_simple_company_member"]),
      orgOperator: cases.map(([action, resource]) => ["orgOperator", action, resource, true, "allow_simple_company_member"]),
      localImplicit: cases.map(([action, resource]) => ["localImplicit", action, resource, true, "allow_local_board"]),
      // The sales-only operator only differs from baseline under enforce; off
      // and shadow must reproduce the pre-change decision exactly.
      salesOperatorBaseline: cases.map(([action, resource]) => ["salesOperatorBaseline", action, resource, true, "allow_simple_company_member"]),
    };

    async function record(name: (typeof actors)[number]) {
      const authz = authorizationService(db);
      const actor = actorFor(name);
      const rows: Row[] = [];
      for (const [action, resource] of cases) {
        const decision = await authz.decide({ actor, action, resource: resourceFor(resource) });
        rows.push([name, action, resource, decision.allowed, decision.reason]);
      }
      return rows;
    }

    for (const mode of ["off", "shadow", "enforce"] as const) {
      it(`matches the pre-change snapshot for owner, admin, org-grant operator and local_implicit (mode=${mode})`, async () => {
        vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
        for (const name of ["owner", "admin", "orgOperator", "localImplicit"] as const) {
          expect(await record(name)).toEqual(snapshot[name]);
        }
      });
    }

    for (const mode of ["off", "shadow"] as const) {
      it(`matches the pre-change snapshot for a restricted operator (mode=${mode})`, async () => {
        vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
        expect(await record("salesOperatorBaseline")).toEqual(snapshot.salesOperatorBaseline);
      });
    }
  });
});

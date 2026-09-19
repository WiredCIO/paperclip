import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  authUsers,
  caseDocuments,
  cases,
  companies,
  companyMemberships,
  createDb,
  documents,
  issueDocuments,
  issues,
  pipelineDocuments,
  pipelines,
  principalPermissionGrants,
  projectBindings,
  projectCategories,
  projects,
  routineDocuments,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  boundEntityPredicate,
  documentVisibilityPredicate,
  getOrCreateProjectVisibilityMemo,
  projectAccessMode,
  projectColumnPredicate,
  resolveProjectVisibility,
  type ProjectVisibilityActor,
} from "./project-visibility.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("projectAccessMode", () => {
  it("returns off when unset", () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", undefined);
    expect(projectAccessMode()).toBe("off");
  });

  it("returns off for an unrecognized value", () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "bogus");
    expect(projectAccessMode()).toBe("off");
  });

  it.each([
    ["shadow", "shadow"],
    ["SHADOW", "shadow"],
    ["Shadow", "shadow"],
    ["enforce", "enforce"],
    ["ENFORCE", "enforce"],
    ["Enforce", "enforce"],
    ["off", "off"],
    ["OFF", "off"],
  ] as const)("parses %s case-insensitively as %s", (raw, expected) => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", raw);
    expect(projectAccessMode()).toBe(expected);
  });
});

describe("getOrCreateProjectVisibilityMemo", () => {
  it("memoizes concurrent calls for the same key", async () => {
    const actor = {};
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve(calls);
    };

    const [a, b] = await Promise.all([
      getOrCreateProjectVisibilityMemo(actor, "company-1:project-1", load),
      getOrCreateProjectVisibilityMemo(actor, "company-1:project-1", load),
    ]);

    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  it("does not share memo entries across keys", async () => {
    const actor = {};
    const a = await getOrCreateProjectVisibilityMemo(actor, "key-a", () => Promise.resolve("a"));
    const b = await getOrCreateProjectVisibilityMemo(actor, "key-b", () => Promise.resolve("b"));
    expect(a).toBe("a");
    expect(b).toBe("b");
  });

  it("evicts a rejected entry so a retry can succeed", async () => {
    const actor = {};
    let attempt = 0;
    const load = () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("recovered");
    };

    await expect(getOrCreateProjectVisibilityMemo(actor, "key", load)).rejects.toThrow("boom");
    await expect(getOrCreateProjectVisibilityMemo(actor, "key", load)).resolves.toBe("recovered");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("resolveProjectVisibility and SQL predicates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  async function createCompany() {
    return db
      .insert(companies)
      .values({ name: `Visibility ${randomUUID()}`, issuePrefix: `PV${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createUser() {
    const id = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id,
      name: `User ${id}`,
      email: `${id}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function createMember(companyId: string, membershipRole: string | null) {
    const userId = await createUser();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
    });
    return userId;
  }

  async function grant(companyId: string, principalId: string, scope: Record<string, unknown> | null) {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId,
      permissionKey: "projects:access",
      scope,
      grantedByUserId: null,
    });
  }

  async function createCategory(companyId: string, name: string) {
    return db
      .insert(projectCategories)
      .values({ companyId, name })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createProject(companyId: string, categoryId: string | null = null) {
    return db
      .insert(projects)
      .values({ companyId, name: `Project ${randomUUID()}`, categoryId })
      .returning()
      .then((rows) => rows[0]!);
  }

  function actorFor(companyId: string, principalId: string): ProjectVisibilityActor {
    return { companyId, principalType: "user", principalId };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
  });

  afterEach(async () => {
    await db.delete(caseDocuments);
    await db.delete(pipelineDocuments);
    await db.delete(routineDocuments);
    await db.delete(issueDocuments);
    await db.delete(projectBindings);
    await db.delete(documents);
    await db.delete(cases);
    await db.delete(pipelines);
    await db.delete(routines);
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

  it("is unrestricted when the access mode is off, regardless of grants", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
    const company = await createCompany();
    const userId = await createMember(company.id, "member");
    await grant(company.id, userId, { projectIds: ["nonexistent"] });

    const resolution = await resolveProjectVisibility(db, actorFor(company.id, userId));
    expect(resolution).toEqual({ kind: "unrestricted" });
  });

  it("is unrestricted for owners and admins with no grant row", async () => {
    const company = await createCompany();
    const ownerId = await createMember(company.id, "owner");
    const adminId = await createMember(company.id, "admin");

    await expect(resolveProjectVisibility(db, actorFor(company.id, ownerId))).resolves.toEqual({
      kind: "unrestricted",
    });
    await expect(resolveProjectVisibility(db, actorFor(company.id, adminId))).resolves.toEqual({
      kind: "unrestricted",
    });
  });

  it("is unrestricted for the local implicit board actor without touching membership", async () => {
    const resolution = await resolveProjectVisibility(db, {
      companyId: randomUUID(),
      principalType: "user",
      principalId: randomUUID(),
      isLocalImplicit: true,
    });
    expect(resolution).toEqual({ kind: "unrestricted" });
  });

  it("is unrestricted for a member with a null-scope grant", async () => {
    const company = await createCompany();
    const userId = await createMember(company.id, "member");
    await grant(company.id, userId, null);

    const resolution = await resolveProjectVisibility(db, actorFor(company.id, userId));
    expect(resolution).toEqual({ kind: "unrestricted" });
  });

  it("resolves a categoryIds grant to every project in that category, evaluated fresh each call", async () => {
    const company = await createCompany();
    const userId = await createMember(company.id, "member");
    const delivery = await createCategory(company.id, "Delivery");
    const projectA = await createProject(company.id, delivery.id);
    await grant(company.id, userId, { categoryIds: [delivery.id] });

    const first = await resolveProjectVisibility(db, actorFor(company.id, userId));
    expect(first.kind).toBe("restricted");
    expect([...(first as { projectIds: Set<string> }).projectIds]).toEqual([projectA.id]);

    const projectB = await createProject(company.id, delivery.id);
    const second = await resolveProjectVisibility(db, actorFor(company.id, userId));
    expect(second.kind).toBe("restricted");
    expect(new Set((second as { projectIds: Set<string> }).projectIds)).toEqual(
      new Set([projectA.id, projectB.id]),
    );
  });

  it("resolves a projectIds grant to exactly that set", async () => {
    const company = await createCompany();
    const userId = await createMember(company.id, "member");
    const projectX = await createProject(company.id);
    await grant(company.id, userId, { projectIds: [projectX.id] });

    const resolution = await resolveProjectVisibility(db, actorFor(company.id, userId));
    expect(resolution).toEqual({ kind: "restricted", projectIds: new Set([projectX.id]) });
  });

  it("resolves to an empty set when there is no grant row at all", async () => {
    const company = await createCompany();
    const userId = await createMember(company.id, "member");

    const resolution = await resolveProjectVisibility(db, actorFor(company.id, userId));
    expect(resolution).toEqual({ kind: "restricted", projectIds: new Set() });
  });

  it("memoizes per actor: a second call on the same actor does not observe a category change made after the first resolve", async () => {
    const company = await createCompany();
    const userId = await createMember(company.id, "member");
    const delivery = await createCategory(company.id, "Delivery");
    const projectA = await createProject(company.id, delivery.id);
    await grant(company.id, userId, { categoryIds: [delivery.id] });

    const actor = actorFor(company.id, userId);
    const first = await resolveProjectVisibility(db, actor);
    expect([...(first as { projectIds: Set<string> }).projectIds]).toEqual([projectA.id]);

    await createProject(company.id, delivery.id);
    const second = await resolveProjectVisibility(db, actor);
    expect(second).toBe(first);
    expect([...(second as { projectIds: Set<string> }).projectIds]).toEqual([projectA.id]);
  });

  describe("projectColumnPredicate", () => {
    it("treats every row as visible when unrestricted", async () => {
      const company = await createCompany();
      const projectA = await createProject(company.id);
      const issue = await db
        .insert(issues)
        .values({ companyId: company.id, title: "Issue", status: "todo", priority: "medium", projectId: projectA.id, originKind: "manual" })
        .returning()
        .then((rows) => rows[0]!);

      const rows = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issue.id), projectColumnPredicate({ kind: "unrestricted" }, issues.projectId)));
      expect(rows).toHaveLength(1);
    });

    it("includes rows in the visible set and rows with a null project", async () => {
      const company = await createCompany();
      const visibleProject = await createProject(company.id);
      const hiddenProject = await createProject(company.id);
      const [visibleIssue, hiddenIssue, unownedIssue] = await Promise.all([
        db.insert(issues).values({ companyId: company.id, title: "V", status: "todo", priority: "medium", projectId: visibleProject.id, originKind: "manual" }).returning().then((r) => r[0]!),
        db.insert(issues).values({ companyId: company.id, title: "H", status: "todo", priority: "medium", projectId: hiddenProject.id, originKind: "manual" }).returning().then((r) => r[0]!),
        db.insert(issues).values({ companyId: company.id, title: "U", status: "todo", priority: "medium", projectId: null, originKind: "manual" }).returning().then((r) => r[0]!),
      ]);

      const resolution = { kind: "restricted" as const, projectIds: new Set([visibleProject.id]) };
      const rows = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, company.id), projectColumnPredicate(resolution, issues.projectId)));
      const ids = new Set(rows.map((row) => row.id));
      expect(ids.has(visibleIssue.id)).toBe(true);
      expect(ids.has(unownedIssue.id)).toBe(true);
      expect(ids.has(hiddenIssue.id)).toBe(false);
    });
  });

  describe("boundEntityPredicate", () => {
    async function createAgentRow(companyId: string) {
      return db
        .insert(agents)
        .values({ companyId, name: `Agent ${randomUUID()}` })
        .returning()
        .then((rows) => rows[0]!);
    }

    it("keeps an unbound entity visible", async () => {
      const company = await createCompany();
      const agent = await createAgentRow(company.id);
      const resolution = { kind: "restricted" as const, projectIds: new Set<string>() };

      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agent.id), boundEntityPredicate(db, resolution, company.id, "agent", agents.id)));
      expect(rows).toHaveLength(1);
    });

    it("hides an entity bound only to a non-visible project", async () => {
      const company = await createCompany();
      const hiddenProject = await createProject(company.id);
      const agent = await createAgentRow(company.id);
      await db.insert(projectBindings).values({
        companyId: company.id,
        projectId: hiddenProject.id,
        targetType: "agent",
        targetId: agent.id,
        createdByUserId: "tester",
      });

      const resolution = { kind: "restricted" as const, projectIds: new Set<string>() };
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agent.id), boundEntityPredicate(db, resolution, company.id, "agent", agents.id)));
      expect(rows).toHaveLength(0);
    });

    it("shows an entity bound to a visible project", async () => {
      const company = await createCompany();
      const visibleProject = await createProject(company.id);
      const agent = await createAgentRow(company.id);
      await db.insert(projectBindings).values({
        companyId: company.id,
        projectId: visibleProject.id,
        targetType: "agent",
        targetId: agent.id,
        createdByUserId: "tester",
      });

      const resolution = { kind: "restricted" as const, projectIds: new Set([visibleProject.id]) };
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agent.id), boundEntityPredicate(db, resolution, company.id, "agent", agents.id)));
      expect(rows).toHaveLength(1);
    });
  });

  describe("documentVisibilityPredicate", () => {
    async function createDocument(companyId: string) {
      return db
        .insert(documents)
        .values({ companyId, latestBody: "body" })
        .returning()
        .then((rows) => rows[0]!);
    }

    it("keeps a fully unowned document visible", async () => {
      const company = await createCompany();
      const doc = await createDocument(company.id);
      const resolution = { kind: "restricted" as const, projectIds: new Set<string>() };

      const rows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, doc.id), documentVisibilityPredicate(db, resolution, company.id, documents.id)));
      expect(rows).toHaveLength(1);
    });

    it("covers the issue owner path", async () => {
      const company = await createCompany();
      const visibleProject = await createProject(company.id);
      const hiddenProject = await createProject(company.id);
      const [visibleDoc, hiddenDoc] = await Promise.all([
        createDocument(company.id),
        createDocument(company.id),
      ]);
      const [visibleIssue, hiddenIssue] = await Promise.all([
        db.insert(issues).values({ companyId: company.id, title: "V", status: "todo", priority: "medium", projectId: visibleProject.id, originKind: "manual" }).returning().then((r) => r[0]!),
        db.insert(issues).values({ companyId: company.id, title: "H", status: "todo", priority: "medium", projectId: hiddenProject.id, originKind: "manual" }).returning().then((r) => r[0]!),
      ]);
      await db.insert(issueDocuments).values([
        { companyId: company.id, issueId: visibleIssue.id, documentId: visibleDoc.id, key: "plan" },
        { companyId: company.id, issueId: hiddenIssue.id, documentId: hiddenDoc.id, key: "plan" },
      ]);

      const resolution = { kind: "restricted" as const, projectIds: new Set([visibleProject.id]) };
      const rows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.companyId, company.id), documentVisibilityPredicate(db, resolution, company.id, documents.id)));
      const ids = new Set(rows.map((row) => row.id));
      expect(ids.has(visibleDoc.id)).toBe(true);
      expect(ids.has(hiddenDoc.id)).toBe(false);
    });

    it("covers the routine, pipeline and case owner paths", async () => {
      const company = await createCompany();
      const visibleProject = await createProject(company.id);
      const hiddenProject = await createProject(company.id);

      const routine = await db.insert(routines).values({ companyId: company.id, title: "R", projectId: visibleProject.id }).returning().then((r) => r[0]!);
      const pipeline = await db.insert(pipelines).values({ companyId: company.id, key: `pipe-${randomUUID()}`, name: "P", projectId: hiddenProject.id }).returning().then((r) => r[0]!);
      const kase = await db
        .insert(cases)
        .values({
          companyId: company.id,
          projectId: visibleProject.id,
          caseNumber: 1,
          identifier: `CASE-${randomUUID()}`,
          caseType: "support",
          title: "Case",
        })
        .returning()
        .then((r) => r[0]!);

      const [routineDoc, pipelineDoc, caseDoc] = await Promise.all([
        createDocument(company.id),
        createDocument(company.id),
        createDocument(company.id),
      ]);
      await db.insert(routineDocuments).values({ companyId: company.id, routineId: routine.id, documentId: routineDoc.id, key: "plan" });
      await db.insert(pipelineDocuments).values({ companyId: company.id, pipelineId: pipeline.id, documentId: pipelineDoc.id, key: "plan" });
      await db.insert(caseDocuments).values({ companyId: company.id, caseId: kase.id, documentId: caseDoc.id, key: "plan" });

      const resolution = { kind: "restricted" as const, projectIds: new Set([visibleProject.id]) };
      const rows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.companyId, company.id), documentVisibilityPredicate(db, resolution, company.id, documents.id)));
      const ids = new Set(rows.map((row) => row.id));
      expect(ids.has(routineDoc.id)).toBe(true);
      expect(ids.has(pipelineDoc.id)).toBe(false);
      expect(ids.has(caseDoc.id)).toBe(true);
    });

    it("covers an explicit binding, overriding an unowned document's default visibility", async () => {
      const company = await createCompany();
      const hiddenProject = await createProject(company.id);
      const doc = await createDocument(company.id);
      await db.insert(projectBindings).values({
        companyId: company.id,
        projectId: hiddenProject.id,
        targetType: "document",
        targetId: doc.id,
        createdByUserId: "tester",
      });

      const resolution = { kind: "restricted" as const, projectIds: new Set<string>() };
      const rows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, doc.id), documentVisibilityPredicate(db, resolution, company.id, documents.id)));
      expect(rows).toHaveLength(0);
    });
  });
});

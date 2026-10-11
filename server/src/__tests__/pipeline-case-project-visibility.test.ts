import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documents,
  instanceSettings,
  issueDocuments,
  issues,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelines,
  principalPermissionGrants,
  projectCategories,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueVisibilityForRequest } from "../routes/authz.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { accessService } from "../services/access.js";
import { redactHiddenAutomationIssueRefs } from "../services/pipelines-aggregation.js";

/**
 * WIR-1020 (T6b): pipeline case detail, liveness, active work, context pack,
 * attention and open-conversation must not reveal an issue that project
 * visibility hides from the caller, and liveness falls through to the next
 * visible linked issue.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("pipeline case responses under project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-case-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issues);
    await db.delete(agents);
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

  const localBoard = {
    type: "board",
    userId: "local-board",
    source: "local_implicit",
    isInstanceAdmin: true,
  } as Express.Request["actor"];

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } } as never));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const prefix = `V${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const [company] = await db.insert(companies).values({
      name: `Pipeline visibility ${randomUUID()}`,
      issuePrefix: prefix,
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
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Worker",
      role: "worker",
      adapterType: "process",
      adapterConfig: {},
    }).returning();

    const setup = request(app(localBoard));
    const pipeline = await setup
      .post(`/api/companies/${companyId}/pipelines`)
      .send({
        key: "visibility",
        name: "Visibility",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      });
    expect(pipeline.status, pipeline.text).toBe(201);

    async function createCase(caseKey: string) {
      const ingested = await setup
        .post(`/api/pipelines/${pipeline.body.id}/cases`)
        .send({ caseKey, title: caseKey })
        .expect(201);
      return ingested.body.case.id as string;
    }

    async function createIssue(input: {
      title: string;
      identifier: string;
      projectId: string;
      status: string;
      updatedAt: Date;
    }) {
      const [issue] = await db.insert(issues).values({
        companyId,
        title: input.title,
        identifier: input.identifier,
        status: input.status,
        priority: "medium",
        projectId: input.projectId,
        assigneeAgentId: agent!.id,
        updatedAt: input.updatedAt,
      }).returning();
      return issue!;
    }

    async function link(caseId: string, issueId: string, role: "work" | "automation" | "conversation") {
      await db.insert(pipelineCaseIssueLinks).values({ companyId, caseId, issueId, role });
    }

    return {
      companyId,
      setup,
      agentId: agent!.id,
      pipelineId: pipeline.body.id as string,
      salesProjectId: salesProject!.id,
      deliveryProjectId: deliveryProject!.id,
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      prefix,
      createCase,
      createIssue,
      link,
    };
  }

  function expectNoTraceOf(body: unknown, issue: { id: string; identifier: string | null; title: string }) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(issue.id);
    if (issue.identifier) expect(text).not.toContain(issue.identifier);
    expect(text).not.toContain(issue.title);
  }

  it("case detail, lists, context pack and attention leave out a Delivery issue; liveness falls through", async () => {
    const fixture = await seed();
    const caseId = await fixture.createCase("case-1");
    // The Delivery issue is the more recently updated in-progress one, so it
    // is what liveness and active work would pick without the filter.
    const salesIssue = await fixture.createIssue({
      title: "Quote follow-up",
      identifier: `${fixture.prefix}-1`,
      projectId: fixture.salesProjectId,
      status: "in_progress",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const deliveryIssue = await fixture.createIssue({
      title: "Rack installation",
      identifier: `${fixture.prefix}-2`,
      projectId: fixture.deliveryProjectId,
      status: "in_progress",
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    });
    await fixture.link(caseId, salesIssue.id, "work");
    await fixture.link(caseId, deliveryIssue.id, "work");
    await db.insert(pipelineCaseEvents).values({
      companyId: fixture.companyId,
      caseId,
      type: "upstream_drift",
      actorType: "system",
      payload: {},
    });

    const owner = request(app(fixture.owner));
    const ownerDetail = await owner.get(`/api/cases/${caseId}`).expect(200);
    expect(ownerDetail.body.links.map((row: { issueId: string }) => row.issueId).sort())
      .toEqual([salesIssue.id, deliveryIssue.id].sort());
    expect(ownerDetail.body.liveness.issue.id).toBe(deliveryIssue.id);
    expect(ownerDetail.body.activeWork.issueId).toBe(deliveryIssue.id);

    const operator = request(app(fixture.salesOperator));
    const detail = await operator.get(`/api/cases/${caseId}`).expect(200);
    expectNoTraceOf(detail.body, deliveryIssue);
    expect(detail.body.links.map((row: { issueId: string }) => row.issueId)).toEqual([salesIssue.id]);
    expect(detail.body.liveness).toMatchObject({ reason: "linked_issue_active", issue: { id: salesIssue.id } });
    expect(detail.body.activeWork.issueId).toBe(salesIssue.id);

    const contextPack = await operator.get(`/api/cases/${caseId}/context-pack`).expect(200);
    expectNoTraceOf(contextPack.body, deliveryIssue);
    expect(contextPack.body.linkedIssues.map((row: { issueId: string }) => row.issueId)).toEqual([salesIssue.id]);

    const list = await operator.get(`/api/pipelines/${fixture.pipelineId}/cases`).expect(200);
    expectNoTraceOf(list.body, deliveryIssue);
    expect(list.body[0].activeWork.issueId).toBe(salesIssue.id);

    const attention = await operator.get(`/api/companies/${fixture.companyId}/pipelines-attention`).expect(200);
    expectNoTraceOf(attention.body, deliveryIssue);
    expect(attention.body.headsUp[0].activeWork.issueId).toBe(salesIssue.id);
    expect(attention.body.headsUp[0].workIssue.issueId).toBe(salesIssue.id);
    const ownerAttention = await owner.get(`/api/companies/${fixture.companyId}/pipelines-attention`).expect(200);
    expect(ownerAttention.body.headsUp[0].workIssue.issueId).toBe(deliveryIssue.id);
  });

  it("liveness reports no linked issue when every linked issue is hidden", async () => {
    const fixture = await seed();
    const caseId = await fixture.createCase("case-hidden-only");
    const deliveryIssue = await fixture.createIssue({
      title: "Blocked delivery work",
      identifier: `${fixture.prefix}-3`,
      projectId: fixture.deliveryProjectId,
      status: "blocked",
      updatedAt: new Date(),
    });
    await fixture.link(caseId, deliveryIssue.id, "work");

    const ownerDetail = await request(app(fixture.owner)).get(`/api/cases/${caseId}`).expect(200);
    expect(ownerDetail.body.liveness).toMatchObject({ reason: "linked_issue_blocked", issue: { id: deliveryIssue.id } });

    const detail = await request(app(fixture.salesOperator)).get(`/api/cases/${caseId}`).expect(200);
    expectNoTraceOf(detail.body, deliveryIssue);
    expect(detail.body.liveness.reason).not.toMatch(/^linked_issue_/);
    expect(detail.body.links).toEqual([]);
  });

  it("open-conversation does not hand a Sales-only operator a hidden Delivery conversation", async () => {
    const fixture = await seed();
    const caseId = await fixture.createCase("case-conversation");
    const deliveryConversation = await fixture.createIssue({
      title: "Delivery discussion",
      identifier: `${fixture.prefix}-4`,
      projectId: fixture.deliveryProjectId,
      status: "todo",
      updatedAt: new Date(),
    });
    await fixture.link(caseId, deliveryConversation.id, "conversation");

    const owner = request(app(fixture.owner));
    const ownerDetail = await owner.get(`/api/cases/${caseId}`).expect(200);
    expect(ownerDetail.body.conversationSource.issue.id).toBe(deliveryConversation.id);
    const ownerOpen = await owner.post(`/api/cases/${caseId}/open-conversation`).expect(200);
    expect(ownerOpen.body).toMatchObject({ created: false, issue: { id: deliveryConversation.id } });

    const operator = request(app(fixture.salesOperator));
    const detail = await operator.get(`/api/cases/${caseId}`).expect(200);
    expectNoTraceOf(detail.body, deliveryConversation);
    expect(detail.body.conversationSource).toBeNull();

    const opened = await operator.post(`/api/cases/${caseId}/open-conversation`);
    expect([200, 201]).toContain(opened.status);
    expectNoTraceOf(opened.body, deliveryConversation);
    expect(opened.body.created).toBe(true);
    expect(opened.body.issue.parentId).toBeNull();

    // The operator's own conversation is reused rather than created again.
    const reopened = await operator.post(`/api/cases/${caseId}/open-conversation`).expect(200);
    expect(reopened.body).toMatchObject({ created: false, issue: { id: opened.body.issue.id } });
  });

  it("outputs, events, the company event feed and a new conversation's description leave out a Delivery issue", async () => {
    const fixture = await seed();
    const caseId = await fixture.createCase("case-outputs");
    const salesIssue = await fixture.createIssue({
      title: "Quote follow-up",
      identifier: `${fixture.prefix}-6`,
      projectId: fixture.salesProjectId,
      status: "done",
      updatedAt: new Date(),
    });
    const deliveryIssue = await fixture.createIssue({
      title: "Rack installation",
      identifier: `${fixture.prefix}-7`,
      projectId: fixture.deliveryProjectId,
      status: "done",
      updatedAt: new Date(),
    });
    // Linking through the API writes issue_linked events carrying the issue id.
    for (const issue of [salesIssue, deliveryIssue]) {
      await fixture.setup.post(`/api/cases/${caseId}/issue-links`).send({ issueId: issue.id, role: "work" }).expect(201);
    }
    for (const [issue, title] of [[salesIssue, "Sales notes"], [deliveryIssue, "Delivery notes"]] as const) {
      const [document] = await db.insert(documents).values({
        companyId: fixture.companyId,
        title,
        latestBody: `${title} body`,
        createdByAgentId: fixture.agentId,
      }).returning();
      await db.insert(issueDocuments).values({
        companyId: fixture.companyId,
        issueId: issue.id,
        documentId: document!.id,
        key: "notes",
      });
    }
    await db.insert(pipelineCaseEvents).values([
      {
        companyId: fixture.companyId,
        caseId,
        type: "automation_executed",
        actorType: "system",
        payload: { automationId: "a", routineId: randomUUID(), issueId: deliveryIssue.id, status: "succeeded" },
      },
      {
        companyId: fixture.companyId,
        caseId,
        type: "upstream_drift",
        actorType: "system",
        payload: { notifiedIssueIds: [salesIssue.id, deliveryIssue.id] },
      },
    ]);

    const owner = request(app(fixture.owner));
    const ownerOutputs = await owner.get(`/api/cases/${caseId}/outputs`).expect(200);
    expect(JSON.stringify(ownerOutputs.body)).toContain(deliveryIssue.id);
    const ownerEvents = await owner.get(`/api/cases/${caseId}/events`).expect(200);
    expect(JSON.stringify(ownerEvents.body)).toContain(deliveryIssue.id);

    const operator = request(app(fixture.salesOperator));
    const outputs = await operator.get(`/api/cases/${caseId}/outputs`).expect(200);
    expectNoTraceOf(outputs.body, deliveryIssue);
    expect(JSON.stringify(outputs.body)).not.toContain("Delivery notes");
    expect(JSON.stringify(outputs.body)).toContain("Sales notes");

    const events = await operator.get(`/api/cases/${caseId}/events`).expect(200);
    expectNoTraceOf(events.body, deliveryIssue);
    expect(JSON.stringify(events.body)).toContain(salesIssue.id);

    const contextPack = await operator.get(`/api/cases/${caseId}/context-pack`).expect(200);
    expectNoTraceOf(contextPack.body, deliveryIssue);

    const companyEvents = await operator.get(`/api/companies/${fixture.companyId}/case-events`).expect(200);
    expectNoTraceOf(companyEvents.body, deliveryIssue);
    expect(JSON.stringify(companyEvents.body)).toContain(salesIssue.id);

    const opened = await operator.post(`/api/cases/${caseId}/open-conversation`);
    expect([200, 201]).toContain(opened.status);
    expect(opened.body.created).toBe(true);
    expectNoTraceOf(opened.body, deliveryIssue);
    expect(opened.body.issue.description).toContain("Sales notes");
  });

  it("automation retry plans and results leave out a Delivery issue id", async () => {
    const fixture = await seed();
    const salesIssue = await fixture.createIssue({
      title: "Quote follow-up",
      identifier: `${fixture.prefix}-8`,
      projectId: fixture.salesProjectId,
      status: "in_progress",
      updatedAt: new Date(),
    });
    const deliveryIssue = await fixture.createIssue({
      title: "Rack installation",
      identifier: `${fixture.prefix}-9`,
      projectId: fixture.deliveryProjectId,
      status: "in_progress",
      updatedAt: new Date(),
    });
    const issueIds = [salesIssue.id, deliveryIssue.id];
    const execution = { id: randomUUID(), executionIssueId: deliveryIssue.id };
    const plan = {
      allowed: false,
      blockers: [
        { kind: "active_descendants", message: "active", issueIds },
        { kind: "unresolved_blockers", message: "blocked", caseIds: [randomUUID()] },
      ],
    };
    const retryResult = {
      plan,
      retired: { caseIds: [], issueIds },
      automationLedger: execution,
      automationExecution: { status: "succeeded", execution },
    };
    const access = accessService(db);
    const visibilityFor = (actor: Express.Request["actor"]) =>
      issueVisibilityForRequest({ actor } as never, access);

    const operatorPlan = await redactHiddenAutomationIssueRefs(db, fixture.companyId, plan, visibilityFor(fixture.salesOperator));
    expect(operatorPlan.blockers[0]).toMatchObject({ kind: "active_descendants", issueIds: [salesIssue.id] });
    expect(operatorPlan.blockers[1]).toEqual(plan.blockers[1]);

    const operatorResult = await redactHiddenAutomationIssueRefs(
      db,
      fixture.companyId,
      retryResult,
      visibilityFor(fixture.salesOperator),
    );
    expectNoTraceOf(operatorResult, deliveryIssue);
    expect(operatorResult.retired.issueIds).toEqual([salesIssue.id]);
    expect(operatorResult.automationLedger.executionIssueId).toBeNull();
    expect(operatorResult.automationExecution.execution.executionIssueId).toBeNull();

    const single = await redactHiddenAutomationIssueRefs(
      db,
      fixture.companyId,
      { status: "succeeded", execution },
      visibilityFor(fixture.salesOperator),
    );
    expect(single.execution.executionIssueId).toBeNull();

    const ownerResult = await redactHiddenAutomationIssueRefs(db, fixture.companyId, retryResult, visibilityFor(fixture.owner));
    expect(ownerResult).toEqual(retryResult);
  });

  it("with project access off every linked issue stays visible and no visibility check is built", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
    const fixture = await seed();
    const caseId = await fixture.createCase("case-off");
    const deliveryIssue = await fixture.createIssue({
      title: "Delivery work",
      identifier: `${fixture.prefix}-5`,
      projectId: fixture.deliveryProjectId,
      status: "in_progress",
      updatedAt: new Date(),
    });
    await fixture.link(caseId, deliveryIssue.id, "work");

    const detail = await request(app(fixture.salesOperator)).get(`/api/cases/${caseId}`).expect(200);
    expect(detail.body.links.map((row: { issueId: string }) => row.issueId)).toEqual([deliveryIssue.id]);
    expect(detail.body.liveness.issue.id).toBe(deliveryIssue.id);

    const decide = vi.fn();
    expect(issueVisibilityForRequest({ actor: fixture.salesOperator } as never, { decide })).toBeUndefined();
    expect(decide).not.toHaveBeenCalled();
  });
});

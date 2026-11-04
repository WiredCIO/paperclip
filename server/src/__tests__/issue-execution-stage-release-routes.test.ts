import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution-stage release route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// WIR-1354: an approver hands approval-gated issues back to an agent so the
// agent can close them; agents still cannot release or pass the stage.
describeEmbeddedPostgres("execution stage release routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-stage-release-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    enqueueWakeup.mockClear();
    await db.delete(issueExecutionDecisions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const builderAgentId = randomUUID();
    const retiredAgentId = randomUUID();
    const approverUserId = `${prefix.toLowerCase()}-approver`;
    const peerUserId = `${prefix.toLowerCase()}-peer`;
    const viewerUserId = `${prefix.toLowerCase()}-viewer`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    const agentRow = (id: string, name: string, status: string) => ({
      id,
      companyId,
      name,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values([
      agentRow(builderAgentId, `${prefix} Builder`, "idle"),
      agentRow(retiredAgentId, `${prefix} Retired Reviewer`, "terminated"),
    ]);
    await db.insert(companyMemberships).values(
      [
        [approverUserId, "operator"],
        [peerUserId, "operator"],
        [viewerUserId, "viewer"],
      ].map(([principalId, membershipRole]) => ({
        companyId,
        principalType: "user",
        principalId,
        status: "active",
        membershipRole,
      })),
    );
    return { companyId, builderAgentId, retiredAgentId, approverUserId, peerUserId, viewerUserId };
  }

  async function seedPendingApproval(input: {
    companyId: string;
    identifier: string;
    approverUserId: string;
    returnAgentId: string;
  }) {
    const issueId = randomUUID();
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "approval", participants: [{ type: "user", userId: input.approverUserId }] }],
    })!;
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: "in_review",
      priority: "medium",
      assigneeUserId: input.approverUserId,
      executionPolicy: policy as any,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: input.approverUserId, agentId: null },
        returnAssignee: { type: "agent", agentId: input.returnAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    });
    return issueId;
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {
      stalledReviewDecisionEnqueueWakeup: enqueueWakeup as any,
    }));
    testApp.use(errorHandler);
    return testApp;
  }

  function boardActor(companyId: string, userId: string, role: "operator" | "viewer" = "operator") {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: role }],
      isInstanceAdmin: false,
    };
  }

  function agentActor(companyId: string, agentId: string, runId = randomUUID()) {
    return { type: "agent", source: "agent_key", companyId, agentId, runId };
  }

  it("releases ten approval-gated issues in one call and records it as the approver's action", async () => {
    const seeded = await seedCompany("REL");
    const issueIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      issueIds.push(await seedPendingApproval({
        companyId: seeded.companyId,
        identifier: `REL-${i + 1}`,
        approverUserId: seeded.approverUserId,
        returnAgentId: seeded.retiredAgentId,
      }));
    }

    const res = await request(app(boardActor(seeded.companyId, seeded.approverUserId)))
      .post(`/api/companies/${seeded.companyId}/issues/execution-stage/release`)
      .send({ issueIds, comment: "Shipped. These are yours to close.", assigneeAgentId: seeded.builderAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.results).toHaveLength(10);
    expect(res.body.results.every((row: { ok: boolean }) => row.ok)).toBe(true);

    const rows = await db.select().from(issues).where(eq(issues.companyId, seeded.companyId));
    for (const row of rows) {
      expect(row.status).toBe("in_progress");
      expect(row.assigneeAgentId).toBe(seeded.builderAgentId);
      expect(row.assigneeUserId).toBeNull();
      expect(row.executionState).toMatchObject({ status: "completed", lastDecisionOutcome: "released" });
    }
    const decisions = await db.select().from(issueExecutionDecisions);
    expect(decisions).toHaveLength(10);
    expect(decisions.every((d) => d.outcome === "released" && d.actorUserId === seeded.approverUserId)).toBe(true);
    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.execution_stage_released"));
    expect(activity).toHaveLength(10);
    expect(activity.every((a) => a.actorType === "user" && a.actorId === seeded.approverUserId)).toBe(true);
    expect(enqueueWakeup).toHaveBeenCalledTimes(10);

    // The builder can now close each one itself, from its own run.
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: seeded.companyId,
      agentId: seeded.builderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: issueIds[0], wakeReason: "issue_status_changed" },
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueIds[0]));
    const close = await request(app(agentActor(seeded.companyId, seeded.builderAgentId, runId)))
      .patch(`/api/issues/${issueIds[0]}`)
      .send({ status: "done", comment: "Shipped; closing." });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(close.body.status).toBe("done");
  });

  it("refuses to hand back to a terminated return assignee unless another agent is named", async () => {
    const seeded = await seedCompany("RET");
    const issueId = await seedPendingApproval({
      companyId: seeded.companyId,
      identifier: "RET-1",
      approverUserId: seeded.approverUserId,
      returnAgentId: seeded.retiredAgentId,
    });
    const res = await request(app(boardActor(seeded.companyId, seeded.approverUserId)))
      .post(`/api/issues/${issueId}/execution-stage/release`)
      .send({ comment: "Release" });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("terminated");
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row.status).toBe("in_review");
  });

  it("an agent can neither release the stage nor close past it", async () => {
    const seeded = await seedCompany("AGT");
    const issueId = await seedPendingApproval({
      companyId: seeded.companyId,
      identifier: "AGT-1",
      approverUserId: seeded.approverUserId,
      returnAgentId: seeded.builderAgentId,
    });
    const agentApp = app(agentActor(seeded.companyId, seeded.builderAgentId));

    const release = await request(agentApp)
      .post(`/api/issues/${issueId}/execution-stage/release`)
      .send({ comment: "Russell said so on another issue" });
    expect(release.status).toBe(403);

    const bulk = await request(agentApp)
      .post(`/api/companies/${seeded.companyId}/issues/execution-stage/release`)
      .send({ issueIds: [issueId], comment: "Russell said so on another issue" });
    expect(bulk.status).toBe(403);

    const close = await request(agentApp)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Closing" });
    // Refused before the stage gate: the issue is assigned to the approver. The
    // stage gate's own 403/422 for an agent is covered in the unit tests.
    expect(close.status).toBe(403);

    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row.status).toBe("in_review");
    expect(row.assigneeUserId).toBe(seeded.approverUserId);
  });

  it("only the stage's own approver can release it; a peer or viewer cannot", async () => {
    const seeded = await seedCompany("PER");
    const issueId = await seedPendingApproval({
      companyId: seeded.companyId,
      identifier: "PER-1",
      approverUserId: seeded.approverUserId,
      returnAgentId: seeded.builderAgentId,
    });

    const peer = await request(app(boardActor(seeded.companyId, seeded.peerUserId)))
      .post(`/api/issues/${issueId}/execution-stage/release`)
      .send({ comment: "Not my stage" });
    expect(peer.status).toBe(403);

    const viewer = await request(app(boardActor(seeded.companyId, seeded.viewerUserId, "viewer")))
      .post(`/api/issues/${issueId}/execution-stage/release`)
      .send({ comment: "Viewer" });
    expect(viewer.status).toBe(403);

    // In a bulk call, the refusal is per issue and nothing changes.
    const bulk = await request(app(boardActor(seeded.companyId, seeded.peerUserId)))
      .post(`/api/companies/${seeded.companyId}/issues/execution-stage/release`)
      .send({ issueIds: [issueId], comment: "Not my stage" });
    expect(bulk.status).toBe(200);
    expect(bulk.body.results).toEqual([
      expect.objectContaining({ issueId, ok: false, status: 403 }),
    ]);

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(0);
  });
});

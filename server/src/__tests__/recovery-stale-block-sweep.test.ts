import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";
import { STALE_BLOCK_SWEEP_MIN_AGE_MS } from "../services/recovery/service.ts";
import { SUCCESSFUL_RUN_MISSING_STATE_REASON } from "../services/recovery/successful-run-handoff.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-block sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const STALE_AT = new Date(Date.now() - STALE_BLOCK_SWEEP_MIN_AGE_MS - 60_000);
const RECENT_AT = new Date();

describeEmbeddedPostgres("recovery sweepStaleBlockRecoveryCatchAlls", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-block-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockTelemetryClient.track.mockClear();
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(agentStatus: string = "idle") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Kimi Reviewer",
      role: "reviewer",
      status: agentStatus,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      invocationSource: "manual",
      finishedAt: new Date(),
    });

    return { companyId, agentId, runId };
  }

  async function seedBlockedIssue(input: {
    companyId: string;
    agentId: string;
    title: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      status: "blocked",
      priority: "high",
      assigneeAgentId: input.agentId,
    });
    return issueId;
  }

  async function seedRecoveryAction(input: {
    companyId: string;
    issueId: string;
    runId: string;
    updatedAt: Date;
    ownerType?: "board" | "agent" | "user" | "system";
    cause?: string;
  }) {
    const actionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: input.ownerType ?? "board",
      cause: input.cause ?? SUCCESSFUL_RUN_MISSING_STATE_REASON,
      fingerprint: `missing_disposition:${input.issueId}`,
      evidence: { correctiveRunId: input.runId, latestRunId: input.runId },
      nextAction: "Board operator: inspect the run evidence and choose a disposition.",
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    });
    return actionId;
  }

  it("returns a stale missing-disposition block to todo when no work product exists", async () => {
    const { companyId, agentId, runId } = await seed();
    const issueId = await seedBlockedIssue({ companyId, agentId, title: "Stale catch-all — no work product" });
    const actionId = await seedRecoveryAction({ companyId, issueId, runId, updatedAt: STALE_AT });

    const result = await heartbeatService(db).sweepStaleBlocks();

    expect(result.restored).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("todo");

    const action = await db.select({ status: issueRecoveryActions.status, outcome: issueRecoveryActions.outcome })
      .from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)).then((rows) => rows[0]);
    expect(action?.status).toBe("resolved");
    expect(action?.outcome).toBe("restored");

    const comment = await db.select({ authorType: issueComments.authorType, body: issueComments.body })
      .from(issueComments).where(eq(issueComments.issueId, issueId)).then((rows) => rows[0]);
    expect(comment?.authorType).toBe("system");
    expect(comment?.body).toContain("todo");

    const audit = await db.select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog).where(eq(activityLog.action, "issue.stale_block_swept")).then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.stale_block_swept");
    expect((audit?.details as { status?: string })?.status).toBe("todo");
  });

  it("returns a stale missing-disposition block to in_review when a work product already exists", async () => {
    const { companyId, agentId, runId } = await seed();
    const issueId = await seedBlockedIssue({ companyId, agentId, title: "Stale catch-all — has work product" });
    await seedRecoveryAction({ companyId, issueId, runId, updatedAt: STALE_AT });
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "Fix the thing",
      status: "open",
    });

    const result = await heartbeatService(db).sweepStaleBlocks();

    expect(result.restored).toBe(1);
    const issue = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("in_review");
  });

  it("never touches a block whose recovery action has not aged past the threshold", async () => {
    const { companyId, agentId, runId } = await seed();
    const issueId = await seedBlockedIssue({ companyId, agentId, title: "Recent catch-all" });
    await seedRecoveryAction({ companyId, issueId, runId, updatedAt: RECENT_AT });

    const result = await heartbeatService(db).sweepStaleBlocks();

    expect(result.restored).toBe(0);
    const issue = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");
  });

  it("never touches a block that has a genuine unresolved dependency", async () => {
    const { companyId, agentId, runId } = await seed();
    const issueId = await seedBlockedIssue({ companyId, agentId, title: "Stale but genuinely blocked" });
    await seedRecoveryAction({ companyId, issueId, runId, updatedAt: STALE_AT });

    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "The real blocker",
      status: "in_progress",
      priority: "high",
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const result = await heartbeatService(db).sweepStaleBlocks();

    expect(result.restored).toBe(0);
    const issue = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");
  });

  it("never touches a block with an explicit ⛔ BLOCKED: comment", async () => {
    const { companyId, agentId, runId } = await seed();
    const issueId = await seedBlockedIssue({ companyId, agentId, title: "Explicitly blocked by an agent" });
    await seedRecoveryAction({ companyId, issueId, runId, updatedAt: STALE_AT });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "⛔ BLOCKED: waiting on a third-party API credential that only the board can grant.",
    });

    const result = await heartbeatService(db).sweepStaleBlocks();

    expect(result.restored).toBe(0);
    const issue = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");
  });

  it("never touches a block while the run that produced it is still running", async () => {
    const { companyId, agentId } = await seed();
    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    const issueId = await seedBlockedIssue({ companyId, agentId, title: "Corrective run still in flight" });
    await seedRecoveryAction({ companyId, issueId, runId: liveRunId, updatedAt: STALE_AT });

    const result = await heartbeatService(db).sweepStaleBlocks();

    expect(result.restored).toBe(0);
    const issue = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");
  });

  it("never touches a block whose assigned agent is not currently invokable", async () => {
    const { companyId, agentId, runId } = await seed("terminated");
    const issueId = await seedBlockedIssue({ companyId, agentId, title: "Assignee terminated" });
    await seedRecoveryAction({ companyId, issueId, runId, updatedAt: STALE_AT });

    const result = await heartbeatService(db).sweepStaleBlocks();

    expect(result.restored).toBe(0);
    const issue = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");
  });

  it("is idempotent — a second pass finds nothing left to restore", async () => {
    const { companyId, agentId, runId } = await seed();
    const issueId = await seedBlockedIssue({ companyId, agentId, title: "Idempotency" });
    await seedRecoveryAction({ companyId, issueId, runId, updatedAt: STALE_AT });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.sweepStaleBlocks();
    const second = await heartbeat.sweepStaleBlocks();

    expect(first.restored).toBe(1);
    expect(second.restored).toBe(0);
  });
});

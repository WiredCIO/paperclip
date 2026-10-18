import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { buildIssueExecutionStageReleasePatch } from "./issue-execution-policy.js";
import { executionIssueCondition } from "./issue-visibility.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";

export interface ReleaseExecutionStageInput {
  issueId: string;
  companyId: string;
  /** Agent to hand the issue back to; defaults to the stage's return assignee. */
  assigneeAgentId?: string | null;
  comment: string;
  actor: { userId: string; runId?: string | null };
}

/**
 * WIR-1354: the active human reviewer/approver hands a pending stage back to an
 * agent so the agent can close the issue. The authority check lives in
 * `buildIssueExecutionStageReleasePatch`; this wraps it in a locked transaction
 * and records the decision, the comment and the activity as the approver's.
 */
export function executionStageReleaseService(db: Db) {
  const svc = issueService(db);
  return {
    release: async (input: ReleaseExecutionStageInput) => {
      const postCommitActivityPublications: ActivityPublication[] = [];
      const postCommitIssueActions: IssuePostCommitAction[] = [];
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const lockedIssue = await tx
          .select()
          .from(issues)
          .where(and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
            executionIssueCondition(),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedIssue) throw notFound("Issue not found");

        const returnAssigneeAgentId =
          (lockedIssue.executionState as { returnAssignee?: { agentId?: string | null } | null } | null)
            ?.returnAssignee?.agentId ?? null;
        const handBackAgentId = input.assigneeAgentId ?? returnAssigneeAgentId;
        if (!handBackAgentId) {
          throw unprocessable("No return assignee on this stage; name assigneeAgentId to hand it back to");
        }
        const handBackAgent = await tx
          .select({ id: agents.id, status: agents.status })
          .from(agents)
          .where(and(eq(agents.id, handBackAgentId), eq(agents.companyId, lockedIssue.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!handBackAgent) {
          throw unprocessable("Hand-back agent must belong to the issue company");
        }
        if (handBackAgent.status === "terminated") {
          throw unprocessable(
            input.assigneeAgentId
              ? "Hand-back agent is terminated"
              : "The stage's return assignee is terminated; name assigneeAgentId to hand it back to",
          );
        }

        const transition = buildIssueExecutionStageReleasePatch({
          issue: lockedIssue,
          actor: { userId: input.actor.userId },
          handBackTo: { type: "agent", agentId: handBackAgent.id, userId: null },
          commentBody: input.comment,
        });
        const decision = transition.decision!;
        const decisionId = randomUUID();
        const executionState = {
          ...(transition.patch.executionState as Record<string, unknown>),
          lastDecisionId: decisionId,
        };

        const comment = await svc.addComment(
          lockedIssue.id,
          decision.body,
          { userId: input.actor.userId, runId: input.actor.runId ?? null },
          { authorType: "user" },
          tx,
        );
        const updated = await svc.update(
          lockedIssue.id,
          {
            ...transition.patch,
            executionState,
            actorUserId: input.actor.userId,
          },
          tx,
          postCommitActivityPublications,
          postCommitIssueActions,
        );
        if (!updated) throw notFound("Issue not found");

        await tx.insert(issueExecutionDecisions).values({
          id: decisionId,
          companyId: updated.companyId,
          issueId: updated.id,
          stageId: decision.stageId,
          stageType: decision.stageType,
          actorAgentId: null,
          actorUserId: input.actor.userId,
          outcome: decision.outcome,
          body: decision.body,
          createdByRunId: input.actor.runId ?? null,
        });

        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: "user",
          actorId: input.actor.userId,
          runId: input.actor.runId ?? null,
          action: "issue.execution_stage_released",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            identifier: updated.identifier,
            stageId: decision.stageId,
            stageType: decision.stageType,
            decisionId,
            commentId: comment.id,
            assigneeAgentId: handBackAgent.id,
            _previous: {
              status: lockedIssue.status,
              assigneeAgentId: lockedIssue.assigneeAgentId,
              assigneeUserId: lockedIssue.assigneeUserId,
            },
          },
        });

        return { issue: updated, comment, decisionId };
      });
      for (const publication of postCommitActivityPublications) publishActivity(publication);
      await executeIssuePostCommitActions(db, postCommitIssueActions);
      return result;
    },
  };
}

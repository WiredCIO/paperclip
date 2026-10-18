import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  buildIssueExecutionStageReleasePatch,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";
import type { IssueExecutionState } from "@paperclipai/shared";

// WIR-1354: the active human approver releases a pending stage back to an
// agent so the agent can close the issue; agents still cannot on their own.

const retiredReviewerAgentId = "11111111-1111-4111-8111-111111111111";
const builderAgentId = "22222222-2222-4222-8222-222222222222";
const qaAgentId = "33333333-3333-4333-8333-333333333333";
const approverUserId = "approver-user";
const otherUserId = "other-user";

const approvalOnly = normalizeIssueExecutionPolicy({
  stages: [{ type: "approval", participants: [{ type: "user", userId: approverUserId }] }],
})!;
const approvalThenReview = normalizeIssueExecutionPolicy({
  stages: [
    { type: "approval", participants: [{ type: "user", userId: approverUserId }] },
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
  ],
})!;

function pendingApproval(policy = approvalOnly) {
  const state: IssueExecutionState = {
    status: "pending",
    currentStageId: policy.stages[0].id,
    currentStageIndex: 0,
    currentStageType: "approval",
    currentParticipant: { type: "user", userId: approverUserId, agentId: null },
    returnAssignee: { type: "agent", agentId: retiredReviewerAgentId, userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    changesRequestedCount: 0,
  };
  return {
    status: "in_review",
    assigneeAgentId: null,
    assigneeUserId: approverUserId,
    executionPolicy: policy,
    executionState: state,
  };
}

const handBackTo = { type: "agent" as const, agentId: builderAgentId, userId: null };

describe("buildIssueExecutionStageReleasePatch", () => {
  it("lets the active approver hand the issue back to an agent, recorded as released", () => {
    const result = buildIssueExecutionStageReleasePatch({
      issue: pendingApproval(),
      actor: { userId: approverUserId },
      handBackTo,
      commentBody: "Shipped; close it yourselves.",
    });

    expect(result.patch).toMatchObject({
      status: "in_progress",
      assigneeAgentId: builderAgentId,
      assigneeUserId: null,
      executionState: {
        status: "completed",
        currentStageId: null,
        currentParticipant: null,
        completedStageIds: [approvalOnly.stages[0].id],
        lastDecisionOutcome: "released",
      },
    });
    expect(result.decision).toEqual({
      stageId: approvalOnly.stages[0].id,
      stageType: "approval",
      outcome: "released",
      body: "Shipped; close it yourselves.",
    });
  });

  it("lets the hand-back agent then close the issue without re-opening the approval", () => {
    const released = buildIssueExecutionStageReleasePatch({
      issue: pendingApproval(),
      actor: { userId: approverUserId },
      handBackTo,
      commentBody: "Released",
    });
    const close = applyIssueExecutionPolicyTransition({
      issue: { ...pendingApproval(), ...released.patch } as ReturnType<typeof pendingApproval>,
      policy: approvalOnly,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: builderAgentId },
      commentBody: "Closing: shipped",
    });

    expect(close.patch).toEqual({});
    expect(close.decision).toBeUndefined();
  });

  it("keeps later stages: the agent's done starts the next stage", () => {
    const released = buildIssueExecutionStageReleasePatch({
      issue: pendingApproval(approvalThenReview),
      actor: { userId: approverUserId },
      handBackTo,
      commentBody: "Released",
    });
    expect(released.patch.executionState).toMatchObject({ status: "idle" });

    const close = applyIssueExecutionPolicyTransition({
      issue: { ...pendingApproval(approvalThenReview), ...released.patch } as ReturnType<typeof pendingApproval>,
      policy: approvalThenReview,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: builderAgentId },
      commentBody: "Done",
    });
    expect(close.patch).toMatchObject({
      status: "in_review",
      assigneeAgentId: qaAgentId,
      executionState: { status: "pending", currentStageId: approvalThenReview.stages[1].id },
    });
  });

  it("rejects an agent, even the return assignee", () => {
    for (const agentId of [builderAgentId, retiredReviewerAgentId]) {
      expect(() =>
        buildIssueExecutionStageReleasePatch({
          issue: pendingApproval(),
          actor: { agentId },
          handBackTo,
          commentBody: "Releasing on Russell's written go-ahead elsewhere",
        }),
      ).toThrow(expect.objectContaining({ status: 403 }));
    }
  });

  it("rejects a human who is not the stage's current participant", () => {
    expect(() =>
      buildIssueExecutionStageReleasePatch({
        issue: pendingApproval(),
        actor: { userId: otherUserId },
        handBackTo,
        commentBody: "Not mine to release",
      }),
    ).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("requires a comment and a pending stage", () => {
    expect(() =>
      buildIssueExecutionStageReleasePatch({
        issue: pendingApproval(),
        actor: { userId: approverUserId },
        handBackTo,
        commentBody: "  ",
      }),
    ).toThrow("requires a comment");

    const notPending = pendingApproval();
    notPending.executionState = { ...notPending.executionState, status: "completed" };
    expect(() =>
      buildIssueExecutionStageReleasePatch({
        issue: notPending,
        actor: { userId: approverUserId },
        handBackTo,
        commentBody: "Released",
      }),
    ).toThrow("no pending review or approval stage");
  });
});

describe("approval stage gate is unchanged for agents (WIR-1354 must-not-change)", () => {
  it("an agent still cannot close an issue with a pending human approval", () => {
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: pendingApproval(),
        policy: approvalOnly,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: builderAgentId },
        commentBody: "Closing: shipped",
      }),
    ).toThrow("Only the active reviewer or approver can advance");
  });

  it("an agent still cannot drop the pending approval by clearing the policy", () => {
    // Clearing the policy is a separate PATCH field guarded at the route; the
    // transition itself never lets an agent's `done` pass the approval.
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: pendingApproval(),
        policy: approvalOnly,
        requestedStatus: "in_progress",
        requestedAssigneePatch: { assigneeAgentId: builderAgentId },
        actor: { agentId: builderAgentId },
        commentBody: "Taking it back",
      }),
    ).toThrow("Only the active reviewer or approver can advance");
  });
});

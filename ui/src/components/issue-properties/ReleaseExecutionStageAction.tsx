import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { issuesApi } from "../../api/issues";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";

interface ReleaseExecutionStageActionProps {
  issue: Issue;
  agents: Agent[] | undefined;
  currentUserId: string | null | undefined;
}

/**
 * WIR-1354: lets the human holding a pending review/approval stage hand the
 * issue back to an agent to close, instead of closing it themselves. Rendered
 * only for that human; the server enforces the same rule.
 */
export function ReleaseExecutionStageAction({ issue, agents, currentUserId }: ReleaseExecutionStageActionProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const state = issue.executionState;
  const activeAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.status !== "terminated"),
    [agents],
  );
  const returnAgentId = state?.returnAssignee?.type === "agent" ? state.returnAssignee.agentId : null;
  const defaultAgentId = activeAgents.some((agent) => agent.id === returnAgentId) ? returnAgentId : null;
  const [agentId, setAgentId] = useState<string>(defaultAgentId ?? "");

  const release = useMutation({
    mutationFn: () => {
      const agent = activeAgents.find((candidate) => candidate.id === agentId);
      return issuesApi.releaseExecutionStage(issue.id, {
        assigneeAgentId: agentId,
        comment: `Released to ${agent?.name ?? "the assignee"} to close.`,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issue.id) });
      pushToast({ title: "Handed back to the agent to close.", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Could not hand the issue back",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  const isActiveHumanParticipant =
    state?.status === "pending" &&
    state.currentParticipant?.type === "user" &&
    !!currentUserId &&
    state.currentParticipant.userId === currentUserId;
  if (!isActiveHumanParticipant) return null;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <select
        aria-label="Agent to hand back to"
        className="min-w-0 flex-1 truncate rounded border border-border bg-transparent px-1.5 py-0.5 text-xs"
        value={agentId}
        onChange={(event) => setAgentId(event.target.value)}
        disabled={release.isPending}
      >
        <option value="" disabled>Choose agent…</option>
        {activeAgents.map((agent) => (
          <option key={agent.id} value={agent.id}>{agent.name}</option>
        ))}
      </select>
      <button
        type="button"
        className="inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
        disabled={!agentId || release.isPending}
        title="Release this stage without approving it; the agent closes the issue"
        onClick={() => release.mutate()}
      >
        Hand back to close
      </button>
    </div>
  );
}

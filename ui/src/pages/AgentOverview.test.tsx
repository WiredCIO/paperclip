// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDetail, AgentRuntimeState, HeartbeatRun, Issue } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentOverview } from "./AgentDetail";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

describe("AgentOverview", () => {
  it("prioritizes identity, capability, runtime, skills, tasks, and scoped Audit entry points", () => {
    const agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex Coder",
      urlKey: "codexcoder",
      role: "engineer",
      title: "Product engineer",
      status: "active",
      reportsTo: null,
      capabilities: "Builds and verifies product changes.",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.6-sol" },
      runtimeConfig: {},
      chainOfCommand: [],
      access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
    } as unknown as AgentDetail;
    const issue = {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-42",
      title: "Simplify agent information architecture",
      status: "in_progress",
      priority: "high",
      updatedAt: new Date("2026-08-31T12:00:00Z"),
    } as unknown as Issue;
    const runtime = {
      sessionDisplayId: "codex-session-42",
    } as unknown as AgentRuntimeState;

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AgentOverview
          agent={agent}
          runs={[] as HeartbeatRun[]}
          assignedIssues={[issue]}
          runtimeState={runtime}
          directReportCount={2}
          skillNames={["Design Guide", "Check PR"]}
          agentRouteId="codexcoder"
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Identity");
    expect(markup).toContain("Capabilities");
    expect(markup).toContain("Harness / Runtime");
    expect(markup).toContain("Design Guide");
    expect(markup).toContain("Simplify agent information architecture");
    expect(markup).toContain("PAP-42");
    expect(markup).toContain('href="/activity/costs?agentId=agent-1"');
    expect(markup).not.toContain("Run Activity");
    expect(markup).not.toContain("Tasks by Status");
  });

  it("shows Claude usage windows for a seat-backed agent's latest completed run", () => {
    const agent = {
      id: "agent-2",
      companyId: "company-1",
      name: "AppDev",
      urlKey: "appdev",
      role: "engineer",
      title: null,
      status: "active",
      reportsTo: null,
      capabilities: null,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      chainOfCommand: [],
      access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
    } as unknown as AgentDetail;
    const run = {
      id: "run-1",
      agentId: "agent-2",
      status: "succeeded",
      createdAt: new Date("2026-09-18T00:00:00Z"),
      usageJson: {
        rateLimit: {
          status: "allowed_warning",
          isUsingOverage: false,
          unifiedWindows: {
            five_hour: { utilization: 0.48, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
            seven_day: { utilization: 0.17, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
          },
        },
      },
    } as unknown as HeartbeatRun;

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AgentOverview
          agent={agent}
          runs={[run]}
          assignedIssues={[]}
          directReportCount={0}
          skillNames={[]}
          agentRouteId="appdev"
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Claude usage");
    expect(markup).toContain("5-hour");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("48%");
    expect(markup).toContain("17%");
    expect(markup).not.toContain("Near limit");
  });

  it("flags a window at or above 80% utilization as near limit", () => {
    const agent = {
      id: "agent-3",
      companyId: "company-1",
      name: "ConnectAbility",
      urlKey: "connectability",
      role: "engineer",
      title: null,
      status: "active",
      reportsTo: null,
      capabilities: null,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      chainOfCommand: [],
      access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
    } as unknown as AgentDetail;
    const run = {
      id: "run-2",
      agentId: "agent-3",
      status: "succeeded",
      createdAt: new Date("2026-09-18T00:00:00Z"),
      usageJson: {
        rateLimit: {
          status: "allowed_warning",
          unifiedWindows: {
            five_hour: { utilization: 0.82, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          },
        },
      },
    } as unknown as HeartbeatRun;

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AgentOverview
          agent={agent}
          runs={[run]}
          assignedIssues={[]}
          directReportCount={0}
          skillNames={[]}
          agentRouteId="connectability"
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Near limit");
    expect(markup).toContain("82%");
  });

  it("shows nothing for an agent bound to an ANTHROPIC_API_KEY even with a stale rateLimit value", () => {
    const agent = {
      id: "agent-4",
      companyId: "company-1",
      name: "CEO",
      urlKey: "ceo",
      role: "ceo",
      title: null,
      status: "active",
      reportsTo: null,
      capabilities: null,
      adapterType: "claude_local",
      adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-configured" } } },
      runtimeConfig: {},
      chainOfCommand: [],
      access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
    } as unknown as AgentDetail;
    const run = {
      id: "run-3",
      agentId: "agent-4",
      status: "succeeded",
      createdAt: new Date("2026-09-18T00:00:00Z"),
      usageJson: {
        rateLimit: {
          status: "allowed",
          unifiedWindows: {
            five_hour: { utilization: 0.05, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          },
        },
      },
    } as unknown as HeartbeatRun;

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AgentOverview
          agent={agent}
          runs={[run]}
          assignedIssues={[]}
          directReportCount={0}
          skillNames={[]}
          agentRouteId="ceo"
        />
      </QueryClientProvider>,
    );

    expect(markup).not.toContain("Claude usage");
  });
});

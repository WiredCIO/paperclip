// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyAccess, CompanyAccessLegacyRoute } from "./CompanyAccess";

const listMembersMock = vi.hoisted(() => vi.fn());
const listJoinRequestsMock = vi.hoisted(() => vi.fn());
const updateMemberMock = vi.hoisted(() => vi.fn());
const archiveMemberMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const listIssuesMock = vi.hoisted(() => vi.fn());
const mockUsePluginSlots = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const listInvitesMock = vi.hoisted(() => vi.fn());
const mockSearchParamsState = vi.hoisted(() => ({ current: new URLSearchParams() }));
const getAccessGrantMock = vi.hoisted(() => vi.fn());
const putAccessGrantMock = vi.hoisted(() => vi.fn());
const deleteAccessGrantMock = vi.hoisted(() => vi.fn());
const listCategoriesMock = vi.hoisted(() => vi.fn());
const listProjectsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    listMembers: (companyId: string) => listMembersMock(companyId),
    listJoinRequests: (companyId: string, status: string) => listJoinRequestsMock(companyId, status),
    updateMember: (companyId: string, memberId: string, input: unknown) =>
      updateMemberMock(companyId, memberId, input),
    updateMemberPermissions: vi.fn(),
    updateMemberAccess: vi.fn(),
    archiveMember: (companyId: string, memberId: string, input: unknown) =>
      archiveMemberMock(companyId, memberId, input),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
    listInvites: (companyId: string, options: unknown) => listInvitesMock(companyId, options),
    createCompanyInvite: vi.fn(),
    revokeInvite: vi.fn(),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("@/api/issues", () => ({
  issuesApi: {
    list: (companyId: string, filters: unknown) => listIssuesMock(companyId, filters),
  },
}));

vi.mock("@/api/project-access", () => ({
  projectAccessApi: {
    getAccessGrant: (companyId: string, userId: string) => getAccessGrantMock(companyId, userId),
    putAccessGrant: (companyId: string, userId: string, scope: unknown) =>
      putAccessGrantMock(companyId, userId, scope),
    deleteAccessGrant: (companyId: string, userId: string) => deleteAccessGrantMock(companyId, userId),
    listCategories: (companyId: string) => listCategoriesMock(companyId),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: (companyId: string) => listProjectsMock(companyId),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => {
    mockNavigate(to, replace);
    return <div data-testid="navigate">{to}</div>;
  },
  useSearchParams: () => [
    mockSearchParamsState.current,
    (
      updater:
        | URLSearchParams
        | ((prev: URLSearchParams) => URLSearchParams),
    ) => {
      mockSearchParamsState.current =
        typeof updater === "function"
          ? updater(mockSearchParamsState.current)
          : new URLSearchParams(updater);
    },
  ],
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: mockUsePluginSlots,
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyAccess", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSearchParamsState.current = new URLSearchParams();
    listInvitesMock.mockResolvedValue({ invites: [], nextOffset: null });
    listMembersMock.mockResolvedValue({
      members: [
        {
          id: "member-1",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-1",
          status: "active",
          membershipRole: "owner",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "user-1",
            email: "codexcoder@paperclip.local",
            name: "Codex Coder",
            image: "/api/assets/avatar-1/content",
          },
          grants: [],
        },
        {
          id: "member-2",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-2",
          status: "active",
          membershipRole: "operator",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "user-2",
            email: "board@paperclip.local",
            name: "Board User",
            image: null,
          },
          grants: [],
        },
      ],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: true,
      },
    });
    listJoinRequestsMock.mockResolvedValue([
      {
        id: "join-1",
        requestType: "human",
        createdAt: "2026-04-10T00:00:00.000Z",
        requesterUser: {
          id: "user-2",
          email: "board@paperclip.local",
          name: "Board User",
          image: null,
        },
        requestEmailSnapshot: "board@paperclip.local",
        requestingUserId: "user-2",
        invite: {
          allowedJoinTypes: "human",
          humanRole: "operator",
        },
      },
      {
        id: "join-2",
        requestType: "agent",
        createdAt: "2026-04-10T00:00:00.000Z",
        agentName: "Codex Worker",
        adapterType: "codex_local",
        capabilities: "Implements code changes",
        invite: {
          allowedJoinTypes: "agent",
          humanRole: null,
        },
      },
    ]);
    updateMemberMock.mockResolvedValue({});
    archiveMemberMock.mockResolvedValue({ reassignedIssueCount: 1 });
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "Codex Worker",
        role: "engineer",
        status: "active",
      },
    ]);
    listIssuesMock.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Assigned to removed user",
        status: "todo",
      },
    ]);
    mockUsePluginSlots.mockReturnValue({
      slots: [],
      isLoading: false,
      errorMessage: null,
    });
    getAccessGrantMock.mockResolvedValue({ grant: { scope: null, updatedAt: "2026-04-10T00:00:00.000Z" } });
    putAccessGrantMock.mockImplementation(async (_companyId: string, _userId: string, scope: unknown) => ({
      scope,
      updatedAt: "2026-04-11T00:00:00.000Z",
    }));
    deleteAccessGrantMock.mockResolvedValue({ deleted: true });
    listCategoriesMock.mockResolvedValue([
      { id: "cat-sales", companyId: "company-1", name: "Sales", sortOrder: 0 },
      { id: "cat-ops", companyId: "company-1", name: "Operations", sortOrder: 1 },
    ]);
    listProjectsMock.mockResolvedValue([
      { id: "project-1", companyId: "company-1", name: "Website" },
    ]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a compact member table without redundant explanatory copy", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Manage the people who can work in Paperclip");
    expect(container.textContent).not.toContain("Members can collaborate across the company by default");
    expect(container.textContent).not.toContain("Core keeps this page focused on membership");
    expect(container.textContent).not.toContain("Manage human company memberships and status here");
    expect(container.textContent).toContain("Pending human joins");
    expect(container.textContent).toContain("Name");
    expect(container.textContent).toContain("Email");
    expect(container.querySelector('[data-slot="avatar"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Grants");
    expect(container.textContent).not.toContain("explicit grants");
    expect(container.textContent).not.toContain("Assign scoped tasks");
    expect(container.textContent).not.toContain("Agents");
    expect(container.textContent).not.toContain("Pending agent joins");
    expect(container.textContent).not.toContain("Open join request queue");
    expect(container.textContent).not.toContain("Manage invites");
    expect(container.textContent).not.toContain("Active user accounts");
    expect(container.textContent).not.toContain("Suspended user accounts");
    expect(container.textContent).not.toContain("Pending user joins");

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Update organization role and membership status");
    expect(document.body.textContent).not.toContain("Implicit grants from role");
    expect(document.body.textContent).not.toContain("permissionKey");

    await act(async () => {
      root.unmount();
    });
  });

  it("saves member role and status without touching grants", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const saveButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Save member",
    );
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(updateMemberMock).toHaveBeenCalledWith("company-1", "member-1", {
      membershipRole: "owner",
      status: "active",
    });
    expect(putAccessGrantMock).not.toHaveBeenCalled();
    expect(deleteAccessGrantMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  async function renderAndEditMember(index: number) {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await openEditDialog(index);
    return root;
  }

  async function openEditDialog(index: number) {
    const editButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent === "Edit",
    );
    await act(async () => {
      editButtons[index]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
  }

  function findLabelInput(text: string) {
    const label = Array.from(document.body.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    return label?.querySelector("input") as HTMLInputElement | null;
  }

  function findButton(text: string) {
    return Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === text,
    ) as HTMLButtonElement | undefined;
  }

  async function click(element: Element | null | undefined) {
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  it("shows a Project access control with Org, Categories and Projects modes", async () => {
    const root = await renderAndEditMember(1);

    expect(getAccessGrantMock).toHaveBeenCalledWith("company-1", "user-2");
    expect(document.body.textContent).toContain("Project access");
    expect(findLabelInput("Org")?.checked).toBe(true);
    expect(findLabelInput("Categories")).toBeTruthy();
    expect(findLabelInput("Projects")).toBeTruthy();

    await click(findLabelInput("Projects"));
    expect(findLabelInput("Website")).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it("restricts a member to a single category and reads it back", async () => {
    const root = await renderAndEditMember(1);

    await click(findLabelInput("Categories"));
    expect(findButton("Save member")?.disabled).toBe(true);
    await click(findLabelInput("Sales"));
    expect(findButton("Save member")?.disabled).toBe(false);

    getAccessGrantMock.mockResolvedValue({
      grant: { scope: { categoryIds: ["cat-sales"] }, updatedAt: "2026-04-11T00:00:00.000Z" },
    });
    await click(findButton("Save member"));

    expect(putAccessGrantMock).toHaveBeenCalledWith("company-1", "user-2", { categoryIds: ["cat-sales"] });
    expect(deleteAccessGrantMock).not.toHaveBeenCalled();

    await openEditDialog(1);
    expect(findLabelInput("Categories")?.checked).toBe(true);
    expect(findLabelInput("Sales")?.checked).toBe(true);
    expect(findLabelInput("Operations")?.checked).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("clears a restriction by writing an explicit null-scope grant for Org, never deleting the grant", async () => {
    getAccessGrantMock.mockResolvedValue({
      grant: { scope: { projectIds: ["project-1"] }, updatedAt: "2026-04-11T00:00:00.000Z" },
    });
    const root = await renderAndEditMember(1);

    expect(findLabelInput("Projects")?.checked).toBe(true);
    expect(findLabelInput("Website")?.checked).toBe(true);

    await click(findLabelInput("Org"));
    await click(findButton("Save member"));

    expect(putAccessGrantMock).toHaveBeenCalledWith("company-1", "user-2", null);
    expect(deleteAccessGrantMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("warns before replacing a grant that combines categories and projects, and leaves it alone if unchanged", async () => {
    getAccessGrantMock.mockResolvedValue({
      grant: {
        scope: { categoryIds: ["cat-sales"], projectIds: ["project-1"] },
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    });
    const root = await renderAndEditMember(1);

    expect(document.body.textContent).toContain("combines categories and individual projects");

    await click(findButton("Save member"));
    expect(updateMemberMock).toHaveBeenCalled();
    expect(putAccessGrantMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not offer project access to non-admin viewers", async () => {
    const members = await listMembersMock();
    listMembersMock.mockResolvedValue({
      ...members,
      access: { ...members.access, currentUserRole: "operator" },
    });
    const root = await renderAndEditMember(1);

    expect(document.body.textContent).not.toContain("Project access");
    expect(getAccessGrantMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("removes a member with an issue reassignment target", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const removeButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent?.includes("Remove"),
    );
    expect(removeButtons.length).toBeGreaterThan(0);

    await act(async () => {
      removeButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Remove member");
    expect(document.body.textContent).toContain("Assigned to removed user");

    const reassignmentSelect = document.body.querySelector("select");
    expect(reassignmentSelect).toBeTruthy();
    await act(async () => {
      reassignmentSelect!.value = "user:user-2";
      reassignmentSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Remove member",
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveMemberMock).toHaveBeenCalledWith("company-1", "member-1", {
      reassignment: { assigneeAgentId: null, assigneeUserId: "user-2" },
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("shows protected member removal reasons from the API", async () => {
    listMembersMock.mockResolvedValueOnce({
      members: [
        {
          id: "member-admin",
          companyId: "company-1",
          principalType: "user",
          principalId: "admin-user",
          status: "active",
          membershipRole: "admin",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "admin-user",
            email: "admin@paperclip.local",
            name: "Admin User",
            image: null,
          },
          grants: [],
          removal: {
            canArchive: false,
            reason: "Company admins cannot be removed from company access.",
          },
        },
      ],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: false,
      },
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Company admins cannot be removed from company access.");
    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Remove"),
    );
    expect(removeButton).toBeTruthy();
    expect(removeButton).toHaveProperty("disabled", true);
    expect(removeButton?.getAttribute("title")).toBe("Company admins cannot be removed from company access.");

    await act(async () => {
      root.unmount();
    });
  });

  it("redirects legacy access deep links to the permissions extension route when installed", async () => {
    mockUsePluginSlots.mockReturnValue({
      slots: [
        {
          type: "companySettingsPage",
          id: "permissions",
          displayName: "Permissions",
          routePath: "permissions",
          pluginKey: "permissions-extension",
        },
      ],
      isLoading: false,
      errorMessage: null,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccessLegacyRoute />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockNavigate).toHaveBeenCalledWith("/company/settings/permissions", true);
    expect(container.textContent).toContain("/company/settings/permissions");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a read-only unavailable fallback for legacy access deep links", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccessLegacyRoute />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Advanced Permissions");
    expect(container.textContent).toContain("Advanced permissions unavailable");
    expect(container.textContent).toContain("Open Members");
    expect(container.textContent).toContain("Open Invites");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("CompanyAccess invites tab", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSearchParamsState.current = new URLSearchParams();
    listInvitesMock.mockResolvedValue({ invites: [], nextOffset: null });
    listMembersMock.mockResolvedValue({
      members: [],
      access: { currentUserRole: "owner", canApproveJoinRequests: false },
    });
    listAgentsMock.mockResolvedValue([]);
    listJoinRequestsMock.mockResolvedValue([]);
    mockUsePluginSlots.mockReturnValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage(queryClient?: QueryClient) {
    const root = createRoot(container);
    const client =
      queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("shows Members and Invites tabs with Members active by default", async () => {
    const root = await renderPage();

    const tabLabels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabLabels).toEqual(["Members", "Invites"]);
    expect(container.textContent).toContain("Organization Members");
    expect(container.textContent).not.toContain("Invite a person");

    await act(async () => {
      root.unmount();
    });
  });

  it("opens the Invites tab from a ?tab=invites deep link", async () => {
    mockSearchParamsState.current = new URLSearchParams("tab=invites");
    const root = await renderPage();

    expect(container.textContent).toContain("Invite a person");
    expect(container.textContent).toContain("Invite history");

    await act(async () => {
      root.unmount();
    });
  });

  it("hides the Invites tab when the operator hides company.invites", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["health"], { hiddenSettings: ["company.invites"] } as never);
    mockSearchParamsState.current = new URLSearchParams("tab=invites");
    const root = await renderPage(client);

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container.textContent).not.toContain("Invite a person");
    expect(container.textContent).toContain("Organization Members");
    expect(listInvitesMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});

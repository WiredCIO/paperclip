// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, ProjectCategory } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { Projects } from "./Projects";

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockResourceMembershipsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  updateProject: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

const mockProjectAccessApi = vi.hoisted(() => ({
  listCategories: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
}));

const mockOpenNewProject = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children?: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewProject: mockOpenNewProject }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: mockResourceMembershipsApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/project-access", () => ({
  projectAccessApi: mockProjectAccessApi,
}));

function makeCategory(overrides: Partial<ProjectCategory>): ProjectCategory {
  return {
    id: "category-a",
    companyId: "company-1",
    name: "Category",
    sortOrder: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: "project-a",
    companyId: "company-1",
    urlKey: "alpha",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Alpha",
    description: null,
    status: "in_progress",
    categoryId: null,
    leadAgentId: null,
    targetDate: null,
    color: "#ef4444",
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project-a",
      effectiveLocalFolder: "/tmp/project-a",
      origin: "local_folder",
    },
    workspaces: [],
    primaryWorkspace: null,
    managedByPlugin: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Projects", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockProjectsApi.list.mockResolvedValue([
      makeProject({
        id: "project-c",
        urlKey: "charlie",
        name: "Charlie",
        updatedAt: new Date("2026-01-10T00:00:00Z"),
      }),
      makeProject({
        id: "project-b",
        urlKey: "bravo",
        name: "Bravo",
        updatedAt: new Date("2026-01-05T00:00:00Z"),
      }),
      makeProject({
        id: "project-a",
        urlKey: "alpha",
        name: "Alpha",
        description: "First project",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ]);
    mockResourceMembershipsApi.listMine.mockResolvedValue({
      projectMemberships: { "project-b": "left" },
      agentMemberships: {},
      updatedAt: null,
    });
    mockResourceMembershipsApi.updateProject.mockResolvedValue({
      resourceType: "project",
      resourceId: "project-b",
      state: "joined",
      updatedAt: new Date("2026-01-05T00:00:00Z"),
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: null,
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      source: "test",
      keyId: null,
    });
    mockProjectAccessApi.listCategories.mockResolvedValue([]);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderProjects() {
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Projects />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  async function openSortMenu() {
    const trigger = container.querySelector<HTMLButtonElement>('button[title="Sort"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  async function chooseSortField(label: string) {
    const item = Array.from(document.body.querySelectorAll("button"))
      .find((element) => element.textContent?.includes(label));
    expect(item).toBeTruthy();

    await act(async () => {
      item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  it("groups joined projects above left projects and defaults sorting by name", async () => {
    await renderProjects();

    const content = container.textContent ?? "";
    expect(container.querySelector('button[title="Sort"]')?.textContent).toContain("Sort: Name");
    expect(content.indexOf("My Projects")).toBeLessThan(content.indexOf("Alpha"));
    expect(content.indexOf("Alpha")).toBeLessThan(content.indexOf("Charlie"));
    expect(content.indexOf("Charlie")).toBeLessThan(content.indexOf("Other Projects"));
    expect(content.indexOf("Other Projects")).toBeLessThan(content.indexOf("Bravo"));
    expect(content).toContain("in progress");
  });

  it("sorts grouped projects by the selected field", async () => {
    await renderProjects();
    await openSortMenu();
    await chooseSortField("Updated");

    const content = container.textContent ?? "";
    expect(content.indexOf("My Projects")).toBeLessThan(content.indexOf("Charlie"));
    expect(content.indexOf("Charlie")).toBeLessThan(content.indexOf("Alpha"));
    expect(content.indexOf("Alpha")).toBeLessThan(content.indexOf("Other Projects"));
  });

  it("reserves description line height for projects without descriptions", async () => {
    await renderProjects();

    const bravoLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((link) =>
      link.textContent?.includes("Bravo"),
    );
    const hiddenDescriptionLine = bravoLink?.querySelector("p[aria-hidden='true']");

    expect(hiddenDescriptionLine).not.toBeNull();
    expect(hiddenDescriptionLine?.className).toContain("min-h-4");
  });

  it("does not show a manage-categories control for non-admin members, and never fetches categories", async () => {
    await renderProjects();

    const content = container.textContent ?? "";
    expect(content).not.toContain("Manage categories");
    expect(mockProjectAccessApi.listCategories).not.toHaveBeenCalled();
  });

  it("shows a manage-categories control for company owners/admins", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: null,
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
      source: "test",
      keyId: null,
    });

    await renderProjects();

    const content = container.textContent ?? "";
    expect(content).toContain("Manage categories");
    expect(mockProjectAccessApi.listCategories).toHaveBeenCalledWith("company-1");
  });

  it("groups projects by category for admins, with uncategorized projects in their own bucket", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: null,
      userId: "user-1",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      memberships: [],
      source: "test",
      keyId: null,
    });
    mockProjectAccessApi.listCategories.mockResolvedValue([
      makeCategory({ id: "category-ops", name: "Ops", sortOrder: 1 }),
      makeCategory({ id: "category-eng", name: "Engineering", sortOrder: 0 }),
    ]);
    mockProjectsApi.list.mockResolvedValue([
      makeProject({
        id: "project-c",
        urlKey: "charlie",
        name: "Charlie",
        categoryId: "category-ops",
      }),
      makeProject({
        id: "project-b",
        urlKey: "bravo",
        name: "Bravo",
        categoryId: null,
      }),
      makeProject({
        id: "project-a",
        urlKey: "alpha",
        name: "Alpha",
        description: "First project",
        categoryId: "category-eng",
      }),
    ]);

    await renderProjects();

    const content = container.textContent ?? "";
    expect(content.indexOf("My Projects")).toBeLessThan(content.indexOf("Engineering"));
    expect(content.indexOf("Engineering")).toBeLessThan(content.indexOf("Alpha"));
    expect(content.indexOf("Alpha")).toBeLessThan(content.indexOf("Ops"));
    expect(content.indexOf("Ops")).toBeLessThan(content.indexOf("Charlie"));
    expect(content.indexOf("Charlie")).toBeLessThan(content.indexOf("Other Projects"));
    expect(content.indexOf("Other Projects")).toBeLessThan(content.indexOf("Uncategorized"));
    expect(content.indexOf("Uncategorized")).toBeLessThan(content.indexOf("Bravo"));
  });
});

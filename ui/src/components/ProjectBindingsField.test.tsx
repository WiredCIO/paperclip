// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectBindingsField, addProjectBindings } from "./ProjectBindingsField";

const mocks = vi.hoisted(() => ({
  boardAccess: { isInstanceAdmin: false, memberships: [] as object[] },
  listBindings: vi.fn(),
  putBindings: vi.fn(),
}));
vi.mock("@/api/access", () => ({
  accessApi: { getCurrentBoardAccess: async () => mocks.boardAccess },
}));
vi.mock("@/api/projects", () => ({
  projectsApi: { list: async () => [{ id: "p-2", name: "Borealis" }, { id: "p-1", name: "Apollo" }] },
}));
vi.mock("@/api/project-access", () => ({
  projectAccessApi: { listBindings: mocks.listBindings, putBindings: mocks.putBindings },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe("addProjectBindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.putBindings.mockResolvedValue({ bindings: [] });
  });

  it("does nothing when no projects are selected", async () => {
    await addProjectBindings("c-1", "skill", "s-1", []);
    expect(mocks.listBindings).not.toHaveBeenCalled();
    expect(mocks.putBindings).not.toHaveBeenCalled();
  });

  it("unions the new rows into the existing company set without duplicating", async () => {
    mocks.listBindings.mockResolvedValue({
      bindings: [
        { id: "b-1", companyId: "c-1", projectId: "p-1", targetType: "agent", targetId: "a-9", createdAt: "x" },
        { id: "b-2", companyId: "c-1", projectId: "p-1", targetType: "tool_connection", targetId: "t-1", createdAt: "x" },
      ],
    });
    await addProjectBindings("c-1", "tool_connection", "t-1", ["p-1", "p-2", "p-2"]);
    expect(mocks.putBindings).toHaveBeenCalledWith("c-1", [
      { projectId: "p-1", targetType: "agent", targetId: "a-9" },
      { projectId: "p-1", targetType: "tool_connection", targetId: "t-1" },
      { projectId: "p-2", targetType: "tool_connection", targetId: "t-1" },
    ]);
  });
});

describe("ProjectBindingsField", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(onChange = vi.fn(), value: string[] = []) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProjectBindingsField companyId="c-1" value={value} onChange={onChange} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  it("renders nothing for a non-admin member", async () => {
    mocks.boardAccess = { isInstanceAdmin: false, memberships: [{ companyId: "c-1", membershipRole: "member" }] };
    await render();
    expect(container.textContent).toBe("");
  });

  it("lists projects alphabetically for a company owner and reports toggles", async () => {
    mocks.boardAccess = { isInstanceAdmin: false, memberships: [{ companyId: "c-1", membershipRole: "owner" }] };
    const onChange = vi.fn();
    await render(onChange, ["p-2"]);
    const labels = [...container.querySelectorAll("[aria-label^='Bind to']")].map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["Bind to Apollo", "Bind to Borealis"]);

    await act(async () => (container.querySelector("[aria-label='Bind to Apollo']") as HTMLButtonElement).click());
    expect(onChange).toHaveBeenLastCalledWith(["p-2", "p-1"]);
    await act(async () => (container.querySelector("[aria-label='Bind to Borealis']") as HTMLButtonElement).click());
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

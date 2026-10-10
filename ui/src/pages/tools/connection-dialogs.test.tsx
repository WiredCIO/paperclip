// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddConnectionDialog } from "./connection-dialogs";

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
  checkConnectionHealth: vi.fn(),
  refreshCatalog: vi.fn(),
  addProjectBindings: vi.fn(),
  pushToast: vi.fn(),
}));
vi.mock("@/api/tools", () => ({
  toolsApi: {
    listApplications: async () => ({ applications: [{ id: "app-1", name: "GitHub" }] }),
    listStdioTemplates: async () => ({ templates: [] }),
    createConnection: mocks.createConnection,
    checkConnectionHealth: mocks.checkConnectionHealth,
    refreshCatalog: mocks.refreshCatalog,
  },
}));
vi.mock("@/api/secrets", () => ({ secretsApi: { list: async () => [] } }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: mocks.pushToast }) }));
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});
// The real picker (admin gating, project list) is covered by ProjectBindingsField.test.tsx.
vi.mock("@/components/ProjectBindingsField", () => ({
  ProjectBindingsField: ({ onChange }: { onChange: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onChange(["project-1"])}>
      Pick project
    </button>
  ),
  addProjectBindings: mocks.addProjectBindings,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const connection = { id: "conn-1", name: "Prod GitHub", healthStatus: "healthy" };

describe("AddConnectionDialog project bindings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createConnection.mockResolvedValue(connection);
    mocks.checkConnectionHealth.mockResolvedValue({ connection });
    mocks.refreshCatalog.mockResolvedValue({ connection, discoveredCount: 3, quarantinedCount: 0 });
    mocks.addProjectBindings.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  async function clickButton(text: string) {
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
    expect(button, `Missing button ${text}`).toBeTruthy();
    await act(async () => button!.click());
    await settle();
  }
  async function fill(id: string, value: string) {
    const input = container.querySelector(`#${id}`) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function createWithProject() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AddConnectionDialog companyId="company-1" defaultApplicationId="app-1" onClose={vi.fn()} />
        </QueryClientProvider>,
      );
    });
    await settle();
    await fill("conn-name", "Prod GitHub");
    await fill("conn-url", "https://mcp.example.com");
    await clickButton("Pick project");
    await clickButton("Create & probe");
  }

  it("binds the new connection to the selected projects and still probes it", async () => {
    await createWithProject();
    expect(mocks.createConnection).toHaveBeenCalledTimes(1);
    expect(mocks.addProjectBindings).toHaveBeenCalledWith("company-1", "tool_connection", "conn-1", ["project-1"]);
    expect(mocks.checkConnectionHealth).toHaveBeenCalledWith("conn-1");
  });

  it("reports a binding failure without failing the created connection", async () => {
    mocks.addProjectBindings.mockRejectedValue(new Error("forbidden"));
    await createWithProject();
    expect(mocks.checkConnectionHealth).toHaveBeenCalledWith("conn-1");
    expect(mocks.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Connection created, but not added to the selected projects", tone: "error" }),
    );
    expect(mocks.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Could not create connection" }));
  });
});

// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectCategory } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManageCategoriesDialog } from "./ManageCategoriesDialog";

const mockProjectAccessApi = vi.hoisted(() => ({
  listCategories: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
}));

const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/project-access", () => ({
  projectAccessApi: mockProjectAccessApi,
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogAction: (
    { children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean },
  ) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function flushReact() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function act(callback: () => void) {
  flushSync(callback);
}

describe("ManageCategoriesDialog", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderDialog() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ManageCategoriesDialog open onOpenChange={() => {}} companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("creates a new category with the next sort order", async () => {
    mockProjectAccessApi.listCategories.mockResolvedValue([makeCategory({ id: "category-a", sortOrder: 0 })]);
    mockProjectAccessApi.createCategory.mockResolvedValue(makeCategory({ id: "category-b", name: "Ops", sortOrder: 1 }));
    await renderDialog();

    const input = container.querySelector<HTMLInputElement>('input[placeholder="New category name"]');
    if (!input) throw new Error("new category input missing");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "Ops");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const addButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Add"));
    act(() => addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    expect(mockProjectAccessApi.createCategory).toHaveBeenCalledWith("company-1", { name: "Ops", sortOrder: 1 });
  });

  it("renames a category", async () => {
    mockProjectAccessApi.listCategories.mockResolvedValue([makeCategory({ id: "category-a", name: "Old name" })]);
    mockProjectAccessApi.updateCategory.mockResolvedValue(makeCategory({ id: "category-a", name: "New name" }));
    await renderDialog();

    const renameButton = container.querySelector<HTMLButtonElement>('button[title="Rename"]');
    act(() => renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    const editInput = Array.from(container.querySelectorAll("input")).find((i) => i.value === "Old name");
    if (!editInput) throw new Error("rename input missing");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(editInput, "New name");
      editInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save");
    act(() => saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    expect(mockProjectAccessApi.updateCategory).toHaveBeenCalledWith("category-a", { name: "New name" });
  });

  it("swaps sort order when moving a category down", async () => {
    mockProjectAccessApi.listCategories.mockResolvedValue([
      makeCategory({ id: "category-a", name: "Engineering", sortOrder: 0 }),
      makeCategory({ id: "category-b", name: "Ops", sortOrder: 1 }),
    ]);
    mockProjectAccessApi.updateCategory.mockResolvedValue(makeCategory({}));
    await renderDialog();

    const moveDownButtons = container.querySelectorAll<HTMLButtonElement>('button[title="Move down"]');
    act(() => moveDownButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    expect(mockProjectAccessApi.updateCategory).toHaveBeenCalledWith("category-a", { sortOrder: 1 });
    expect(mockProjectAccessApi.updateCategory).toHaveBeenCalledWith("category-b", { sortOrder: 0 });
  });

  it("deletes a category after confirming", async () => {
    mockProjectAccessApi.listCategories.mockResolvedValue([makeCategory({ id: "category-a", name: "Engineering" })]);
    mockProjectAccessApi.deleteCategory.mockResolvedValue(makeCategory({ id: "category-a", name: "Engineering" }));
    await renderDialog();

    const deleteButton = container.querySelector<HTMLButtonElement>('button[title="Delete"]');
    act(() => deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    const confirmButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Delete");
    act(() => confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    expect(mockProjectAccessApi.deleteCategory).toHaveBeenCalledWith("category-a");
  });
});

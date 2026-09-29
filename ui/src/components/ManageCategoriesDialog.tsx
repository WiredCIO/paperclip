import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectCategory } from "@paperclipai/shared";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { projectAccessApi } from "@/api/project-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** Swaps the sort order of two adjacent categories so a move persists as two small PATCHes. */
function swapPlan(categories: ProjectCategory[], index: number, direction: -1 | 1) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= categories.length) return null;
  const current = categories[index]!;
  const target = categories[targetIndex]!;
  return [
    { id: current.id, sortOrder: target.sortOrder },
    { id: target.id, sortOrder: current.sortOrder },
  ];
}

export function ManageCategoriesDialog({
  open,
  onOpenChange,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deletingCategory, setDeletingCategory] = useState<ProjectCategory | null>(null);

  const categoriesQuery = useQuery({
    queryKey: queryKeys.projectCategories.list(companyId),
    queryFn: () => projectAccessApi.listCategories(companyId),
    enabled: open && !!companyId,
  });
  const categories = categoriesQuery.data ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.projectCategories.list(companyId) });

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      projectAccessApi.createCategory(companyId, {
        name,
        sortOrder: categories.length > 0 ? Math.max(...categories.map((c) => c.sortOrder)) + 1 : 0,
      }),
    onSuccess: async () => {
      setNewName("");
      await invalidate();
    },
    onError: (error) => pushToast({ title: "Failed to create category", body: errorMessage(error), tone: "error" }),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      projectAccessApi.updateCategory(input.id, { name: input.name }),
    onSuccess: async () => {
      setEditingId(null);
      await invalidate();
    },
    onError: (error) => pushToast({ title: "Failed to rename category", body: errorMessage(error), tone: "error" }),
  });

  const reorderMutation = useMutation({
    mutationFn: (updates: Array<{ id: string; sortOrder: number }>) =>
      Promise.all(updates.map((update) => projectAccessApi.updateCategory(update.id, { sortOrder: update.sortOrder }))),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error) => pushToast({ title: "Failed to reorder categories", body: errorMessage(error), tone: "error" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => projectAccessApi.deleteCategory(id),
    onSuccess: async () => {
      setDeletingCategory(null);
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(companyId) });
      pushToast({ title: "Category deleted", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Failed to delete category", body: errorMessage(error), tone: "error" }),
  });

  const handleCreate = () => {
    const name = newName.trim();
    if (!name || createMutation.isPending) return;
    createMutation.mutate(name);
  };

  const startEditing = (category: ProjectCategory) => {
    setEditingId(category.id);
    setEditingName(category.name);
  };

  const submitRename = () => {
    const name = editingName.trim();
    if (!editingId || !name) return;
    renameMutation.mutate({ id: editingId, name });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manage categories</DialogTitle>
            <DialogDescription>
              Group projects into categories. Projects without a category appear under "Uncategorized".
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {categoriesQuery.isLoading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {!categoriesQuery.isLoading && categories.length === 0 && (
              <p className="text-sm text-muted-foreground">No categories yet.</p>
            )}
            {categories.map((category, index) => (
              <div
                key={category.id}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
              >
                <div className="flex flex-col">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-4 w-5"
                    title="Move up"
                    disabled={index === 0 || reorderMutation.isPending}
                    onClick={() => {
                      const plan = swapPlan(categories, index, -1);
                      if (plan) reorderMutation.mutate(plan);
                    }}
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-4 w-5"
                    title="Move down"
                    disabled={index === categories.length - 1 || reorderMutation.isPending}
                    onClick={() => {
                      const plan = swapPlan(categories, index, 1);
                      if (plan) reorderMutation.mutate(plan);
                    }}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                </div>

                {editingId === category.id ? (
                  <div className="flex flex-1 items-center gap-1">
                    <Input
                      autoFocus
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitRename();
                        if (event.key === "Escape") setEditingId(null);
                      }}
                      className="h-8"
                    />
                    <Button size="sm" onClick={submitRename} disabled={renameMutation.isPending}>
                      Save
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditingId(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <span className="flex-1 truncate text-sm">{category.name}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Rename"
                      onClick={() => startEditing(category)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      title="Delete"
                      onClick={() => setDeletingCategory(category)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-2">
            <Input
              value={newName}
              placeholder="New category name"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleCreate();
              }}
              className="h-8"
            />
            <Button size="sm" onClick={handleCreate} disabled={!newName.trim() || createMutation.isPending}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deletingCategory} onOpenChange={(next) => !next && setDeletingCategory(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingCategory?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Projects in this category become uncategorized. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingCategory && deleteMutation.mutate(deletingCategory.id)}
              disabled={deleteMutation.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

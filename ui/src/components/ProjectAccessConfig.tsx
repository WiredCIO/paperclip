import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, ProjectBinding, ProjectBindingTargetType } from "@paperclipai/shared";
import { X } from "lucide-react";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { projectAccessApi, type ProjectBindingInput } from "../api/project-access";
import { projectsApi } from "../api/projects";
import { toolsApi } from "../api/tools";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";

const SELECT_CLASS =
  "h-8 w-full max-w-xs rounded-md border border-border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

const TARGET_LABELS: Record<ProjectBindingTargetType, string> = {
  agent: "Agents",
  tool_connection: "Connectors",
  skill: "Skills",
  document: "Documents",
};

const TARGET_ORDER: ProjectBindingTargetType[] = ["agent", "tool_connection", "skill", "document"];

type Candidate = { id: string; name: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * The bindings API replaces the company's whole binding set, so a change to this project's
 * bindings is a read-merge-write: re-read the current set, keep every other project's rows
 * untouched, and swap in this project's desired rows.
 */
export function mergeProjectBindings(
  existing: ProjectBinding[],
  projectId: string,
  change: { add?: { targetType: ProjectBindingTargetType; targetId: string }; remove?: { targetType: ProjectBindingTargetType; targetId: string } },
): ProjectBindingInput[] {
  const merged: ProjectBindingInput[] = existing
    .filter(
      (binding) =>
        !(
          change.remove &&
          binding.projectId === projectId &&
          binding.targetType === change.remove.targetType &&
          binding.targetId === change.remove.targetId
        ),
    )
    .map(({ projectId: pid, targetType, targetId }) => ({ projectId: pid, targetType, targetId }));
  if (
    change.add &&
    !merged.some(
      (binding) =>
        binding.projectId === projectId &&
        binding.targetType === change.add!.targetType &&
        binding.targetId === change.add!.targetId,
    )
  ) {
    merged.push({ projectId, ...change.add });
  }
  return merged;
}

interface ProjectAccessConfigProps {
  project: Project;
  onProjectUpdated?: () => void;
}

/** Category select and bound resources for a project (Configuration tab). Owner/admin only server-side. */
export function ProjectAccessConfig({ project, onProjectUpdated }: ProjectAccessConfigProps) {
  const companyId = project.companyId;
  const queryClient = useQueryClient();
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const membership = boardAccessQuery.data?.memberships?.find((m) => m.companyId === companyId);
  // Mirrors `assertBoardCompanyOwnerOrAdmin` in server/src/routes/project-access.ts — every
  // fetch below 403s for anyone else, so they stay gated on the same check.
  const isAdmin =
    Boolean(boardAccessQuery.data?.isInstanceAdmin) ||
    membership?.membershipRole === "owner" ||
    membership?.membershipRole === "admin";

  const categoriesQuery = useQuery({
    queryKey: queryKeys.projectCategories.list(companyId),
    queryFn: () => projectAccessApi.listCategories(companyId),
    enabled: isAdmin,
  });
  const bindingsQuery = useQuery({
    queryKey: queryKeys.projectBindings.list(companyId),
    queryFn: () => projectAccessApi.listBindings(companyId),
    enabled: isAdmin,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: isAdmin,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
    enabled: isAdmin,
  });
  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId),
    enabled: isAdmin,
  });

  const candidates: Record<ProjectBindingTargetType, Candidate[] | null> = {
    agent: (agentsQuery.data ?? []).map((agent) => ({ id: agent.id, name: agent.name })),
    tool_connection: (connectionsQuery.data?.connections ?? []).map((c) => ({ id: c.id, name: c.name })),
    skill: (skillsQuery.data ?? []).map((skill) => ({ id: skill.id, name: skill.name })),
    // No company-wide documents list exists in the UI client; document bindings are listed and
    // removable here, but are added elsewhere.
    document: null,
  };

  const setCategory = useMutation({
    mutationFn: (categoryId: string | null) => projectsApi.update(project.id, { categoryId }, companyId),
    onMutate: () => setCategoryError(null),
    onSuccess: () => onProjectUpdated?.(),
    onError: (error) => setCategoryError(errorMessage(error)),
  });

  const changeBinding = useMutation({
    mutationFn: async (change: Parameters<typeof mergeProjectBindings>[2]) => {
      // Re-read immediately before writing to keep the whole-set-replace race window small.
      const { bindings } = await projectAccessApi.listBindings(companyId);
      return projectAccessApi.putBindings(companyId, mergeProjectBindings(bindings, project.id, change));
    },
    onMutate: () => setBindingError(null),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.projectBindings.list(companyId), result);
    },
    onError: (error) => {
      setBindingError(errorMessage(error));
      queryClient.invalidateQueries({ queryKey: queryKeys.projectBindings.list(companyId) });
    },
  });

  if (boardAccessQuery.isLoading) return null;

  if (!isAdmin) {
    return (
      <section className="mt-6 space-y-2" aria-labelledby="project-access-heading">
        <h3 id="project-access-heading" className="text-sm font-medium">
          Category and bound resources
        </h3>
        <p className="text-sm text-muted-foreground">
          Only company owners or admins can change a project's category or bound resources.
        </p>
      </section>
    );
  }

  const categories = categoriesQuery.data ?? [];
  const projectBindings = (bindingsQuery.data?.bindings ?? []).filter((b) => b.projectId === project.id);

  function nameFor(targetType: ProjectBindingTargetType, targetId: string) {
    return candidates[targetType]?.find((c) => c.id === targetId)?.name ?? targetId;
  }

  return (
    <div className="mt-6 space-y-6">
      <section className="space-y-2" aria-labelledby="project-category-heading">
        <h3 id="project-category-heading" className="text-sm font-medium">
          Category
        </h3>
        <select
          aria-label="Project category"
          className={SELECT_CLASS}
          value={project.categoryId ?? ""}
          disabled={setCategory.isPending || categoriesQuery.isLoading}
          onChange={(event) => setCategory.mutate(event.target.value || null)}
        >
          <option value="">No category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        {categoriesQuery.error ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load categories: {errorMessage(categoriesQuery.error)}
          </p>
        ) : null}
        {categoryError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not change category: {categoryError}
          </p>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="project-bindings-heading">
        <h3 id="project-bindings-heading" className="text-sm font-medium">
          Bound resources
        </h3>
        {bindingsQuery.error ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load bindings: {errorMessage(bindingsQuery.error)}
          </p>
        ) : null}
        {bindingError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not update bindings: {bindingError}
          </p>
        ) : null}
        {TARGET_ORDER.map((targetType) => {
          const bound = projectBindings.filter((b) => b.targetType === targetType);
          const boundIds = new Set(bound.map((b) => b.targetId));
          const available = candidates[targetType]?.filter((c) => !boundIds.has(c.id)) ?? null;
          return (
            <div key={targetType} className="space-y-1.5">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {TARGET_LABELS[targetType]}
              </h4>
              {bound.length === 0 ? (
                <p className="text-sm text-muted-foreground">None bound.</p>
              ) : (
                <ul className="space-y-1">
                  {bound.map((binding) => {
                    const name = nameFor(targetType, binding.targetId);
                    return (
                      <li key={binding.id} className="flex items-center gap-2 text-sm">
                        <span className="truncate">{name}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Unbind ${name}`}
                          disabled={changeBinding.isPending}
                          onClick={() =>
                            changeBinding.mutate({ remove: { targetType, targetId: binding.targetId } })
                          }
                        >
                          <X />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {available ? (
                <select
                  aria-label={`Bind ${TARGET_LABELS[targetType].toLowerCase()}`}
                  className={SELECT_CLASS}
                  value=""
                  disabled={changeBinding.isPending || available.length === 0}
                  onChange={(event) => {
                    if (event.target.value) {
                      changeBinding.mutate({ add: { targetType, targetId: event.target.value } });
                    }
                  }}
                >
                  <option value="">
                    {available.length === 0 ? "Nothing left to bind" : `Add ${TARGET_LABELS[targetType].toLowerCase()}…`}
                  </option>
                  {available.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}

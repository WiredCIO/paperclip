import { useQuery } from "@tanstack/react-query";
import type { ProjectBindingTargetType } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { projectAccessApi } from "@/api/project-access";
import { projectsApi } from "@/api/projects";
import { Checkbox } from "@/components/ui/checkbox";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Project bindings are owner/admin-gated server-side (`assertBoardCompanyOwnerOrAdmin` in
 * `server/src/routes/project-access.ts`), so the picker is only offered to the same set of users —
 * anyone else would hit a 403 on save.
 */
export function useCanManageProjectBindings(companyId: string | null | undefined) {
  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const membership = boardAccessQuery.data?.memberships?.find((m) => m.companyId === companyId);
  return (
    Boolean(companyId) &&
    (Boolean(boardAccessQuery.data?.isInstanceAdmin) ||
      membership?.membershipRole === "owner" ||
      membership?.membershipRole === "admin")
  );
}

/**
 * Binds a freshly created entity to the given projects. The bindings PUT replaces the company's
 * whole set, so read the current set and union the new rows into it before writing back.
 */
export async function addProjectBindings(
  companyId: string,
  targetType: ProjectBindingTargetType,
  targetId: string,
  projectIds: readonly string[],
) {
  if (projectIds.length === 0) return;
  const { bindings } = await projectAccessApi.listBindings(companyId);
  const next = bindings.map(({ projectId, targetType, targetId }) => ({ projectId, targetType, targetId }));
  for (const projectId of projectIds) {
    if (!next.some((b) => b.projectId === projectId && b.targetType === targetType && b.targetId === targetId)) {
      next.push({ projectId, targetType, targetId });
    }
  }
  await projectAccessApi.putBindings(companyId, next);
}

export function ProjectBindingsField({
  companyId,
  value,
  onChange,
  disabled = false,
}: {
  companyId: string;
  value: readonly string[];
  onChange: (projectIds: string[]) => void;
  disabled?: boolean;
}) {
  const canManage = useCanManageProjectBindings(companyId);
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: canManage,
  });
  const projects = [...(projectsQuery.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (!canManage || projects.length === 0) return null;

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">Projects</legend>
      <p className="text-xs text-muted-foreground">Optional. Make this available to the selected projects.</p>
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
        {projects.map((project) => (
          <label key={project.id} className="flex cursor-pointer items-center gap-2 px-1 py-1 text-sm">
            <Checkbox
              checked={value.includes(project.id)}
              disabled={disabled}
              aria-label={`Bind to ${project.name}`}
              onCheckedChange={(checked) =>
                onChange(checked ? [...value, project.id] : value.filter((id) => id !== project.id))
              }
            />
            <span className="truncate">{project.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

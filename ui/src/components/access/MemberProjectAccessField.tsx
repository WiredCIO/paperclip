import type { Project, ProjectAccessScope, ProjectCategory } from "@paperclipai/shared";

export type ProjectAccessMode = "org" | "categories" | "projects";

/**
 * Draft of a member's `projects:access` grant. `mode: null` means the member
 * has no grant row at all — which the server's visibility resolver treats as
 * a hard deny, not as unrestricted (see `server/src/services/project-visibility.ts`).
 */
export type ProjectAccessDraft = {
  mode: ProjectAccessMode | null;
  categoryIds: string[];
  projectIds: string[];
};

export function draftFromScope(grant: { scope: ProjectAccessScope } | null): ProjectAccessDraft {
  if (!grant) return { mode: null, categoryIds: [], projectIds: [] };
  const categoryIds = grant.scope?.categoryIds ?? [];
  const projectIds = grant.scope?.projectIds ?? [];
  if (categoryIds.length > 0) return { mode: "categories", categoryIds, projectIds: [] };
  if (projectIds.length > 0) return { mode: "projects", categoryIds: [], projectIds };
  return { mode: "org", categoryIds: [], projectIds: [] };
}

/** "Org" is an explicit null-scope grant; deleting the row would deny everything. */
/**
 * The API accepts a scope with both `categoryIds` and `projectIds` (the
 * resolver unions them), but this control edits one list at a time. Such a
 * grant is surfaced as a warning so saving a change never drops half of it
 * silently.
 */
export function isCombinedScope(grant: { scope: ProjectAccessScope } | null) {
  return Boolean(grant?.scope?.categoryIds?.length && grant.scope.projectIds?.length);
}

export function scopeFromDraft(draft: ProjectAccessDraft): ProjectAccessScope {
  if (draft.mode === "categories") return { categoryIds: draft.categoryIds };
  if (draft.mode === "projects") return { projectIds: draft.projectIds };
  return null;
}

export function isProjectAccessDraftComplete(draft: ProjectAccessDraft) {
  if (draft.mode === "categories") return draft.categoryIds.length > 0;
  if (draft.mode === "projects") return draft.projectIds.length > 0;
  return true;
}

const modeOptions: Array<{ value: ProjectAccessMode; label: string }> = [
  { value: "org", label: "Org" },
  { value: "categories", label: "Categories" },
  { value: "projects", label: "Projects" },
];

function toggleId(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

export function MemberProjectAccessField({
  draft,
  onChange,
  categories,
  projects,
  roleBypassesRestriction,
  combinedScope = false,
}: {
  draft: ProjectAccessDraft;
  onChange: (draft: ProjectAccessDraft) => void;
  categories: ProjectCategory[];
  projects: Project[];
  roleBypassesRestriction: boolean;
  combinedScope?: boolean;
}) {
  const options =
    draft.mode === "categories"
      ? categories.map((category) => ({ id: category.id, name: category.name }))
      : draft.mode === "projects"
        ? projects.map((project) => ({ id: project.id, name: project.name }))
        : [];
  const selectedIds = draft.mode === "categories" ? draft.categoryIds : draft.projectIds;

  return (
    <fieldset className="space-y-3 text-sm">
      <legend className="font-medium">Project access</legend>
      <div role="radiogroup" aria-label="Project access" className="flex flex-wrap gap-4">
        {modeOptions.map((option) => (
          <label key={option.value} className="flex items-center gap-2">
            <input
              type="radio"
              name="project-access-mode"
              value={option.value}
              checked={draft.mode === option.value}
              onChange={() => onChange({ ...draft, mode: option.value })}
            />
            {option.label}
          </label>
        ))}
      </div>
      {draft.mode === null && (
        <p className="text-xs text-muted-foreground">
          No project access grant on file. Without one, this member sees no projects when project access control is
          enforced.
        </p>
      )}
      {combinedScope && (
        <p className="text-xs text-destructive">
          This member's grant combines categories and individual projects. This control edits one list at a time —
          changing it replaces the whole grant with the selection below.
        </p>
      )}
      {roleBypassesRestriction && (
        <p className="text-xs text-muted-foreground">
          Owners and admins see every project regardless of this setting.
        </p>
      )}
      {(draft.mode === "categories" || draft.mode === "projects") && (
        <div className="space-y-2">
          {options.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {draft.mode === "categories" ? "This company has no categories yet." : "This company has no projects yet."}
            </p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {options.map((option) => (
                <label key={option.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(option.id)}
                    onChange={() =>
                      onChange(
                        draft.mode === "categories"
                          ? { ...draft, categoryIds: toggleId(draft.categoryIds, option.id) }
                          : { ...draft, projectIds: toggleId(draft.projectIds, option.id) },
                      )
                    }
                  />
                  {option.name}
                </label>
              ))}
            </div>
          )}
          {selectedIds.length === 0 && (
            <p className="text-xs text-destructive">
              Select at least one {draft.mode === "categories" ? "category" : "project"}.
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}

import type {
  CreateProjectCategory,
  ProjectAccessScope,
  ProjectAccessGrant,
  ProjectBinding,
  ProjectBindingTargetType,
  ProjectCategory,
  UpdateProjectCategory,
} from "@paperclipai/shared";
import { api } from "./client";

export type ProjectBindingInput = {
  projectId: string;
  targetType: ProjectBindingTargetType;
  targetId: string;
};

/**
 * Client for `server/src/routes/project-access.ts` — categories, bindings and
 * per-member access grants. All routes are owner/admin-gated server-side.
 */
export const projectAccessApi = {
  listCategories: (companyId: string) =>
    api.get<ProjectCategory[]>(`/companies/${encodeURIComponent(companyId)}/project-categories`),

  createCategory: (companyId: string, data: CreateProjectCategory) =>
    api.post<ProjectCategory>(`/companies/${encodeURIComponent(companyId)}/project-categories`, data),

  updateCategory: (id: string, data: UpdateProjectCategory) =>
    api.patch<ProjectCategory>(`/project-categories/${encodeURIComponent(id)}`, data),

  deleteCategory: (id: string) => api.delete<ProjectCategory>(`/project-categories/${encodeURIComponent(id)}`),

  listBindings: (companyId: string) =>
    api.get<{ bindings: ProjectBinding[] }>(`/companies/${encodeURIComponent(companyId)}/project-bindings`),

  putBindings: (companyId: string, bindings: ProjectBindingInput[]) =>
    api.put<{ bindings: ProjectBinding[] }>(`/companies/${encodeURIComponent(companyId)}/project-bindings`, {
      bindings,
    }),

  getAccessGrant: (companyId: string, userId: string) =>
    api.get<{ grant: ProjectAccessGrant | null }>(
      `/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}/project-access`,
    ),

  putAccessGrant: (companyId: string, userId: string, scope: ProjectAccessScope) =>
    api.put<ProjectAccessGrant>(
      `/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}/project-access`,
      { scope },
    ),

  deleteAccessGrant: (companyId: string, userId: string) =>
    api.delete<{ deleted: boolean }>(
      `/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}/project-access`,
    ),
};

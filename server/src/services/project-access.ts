import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  companySkills,
  documents,
  principalPermissionGrants,
  projectBindings,
  projectCategories,
  projects,
  toolConnections,
} from "@paperclipai/db";
import type { ProjectBindingTargetTypeValue } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { isUniqueViolation } from "../db-errors.js";

const PROJECTS_ACCESS_PERMISSION_KEY = "projects:access";

export type ProjectBindingInput = {
  projectId: string;
  targetType: ProjectBindingTargetTypeValue;
  targetId: string;
};

export type ProjectAccessGrantScope = { categoryIds?: string[]; projectIds?: string[] } | null;

/** Every project id a caller references must exist and belong to the same company, same rationale as `assertGoalsBelongToCompany` in services/projects.ts. */
async function assertProjectsBelongToCompany(db: Db, companyId: string, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const unique = [...new Set(projectIds)];
  const found = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), inArray(projects.id, unique)));
  const foundIds = new Set(found.map((row) => row.id));
  const unknown = unique.filter((id) => !foundIds.has(id));
  if (unknown.length > 0) {
    throw unprocessable(`Unknown project id(s) for this company: ${unknown.join(", ")}`, { unknownProjectIds: unknown });
  }
}

async function assertCategoriesBelongToCompany(db: Db, companyId: string, categoryIds: string[]): Promise<void> {
  if (categoryIds.length === 0) return;
  const unique = [...new Set(categoryIds)];
  const found = await db
    .select({ id: projectCategories.id })
    .from(projectCategories)
    .where(and(eq(projectCategories.companyId, companyId), inArray(projectCategories.id, unique)));
  const foundIds = new Set(found.map((row) => row.id));
  const unknown = unique.filter((id) => !foundIds.has(id));
  if (unknown.length > 0) {
    throw unprocessable(`Unknown project category id(s) for this company: ${unknown.join(", ")}`, { unknownCategoryIds: unknown });
  }
}

/**
 * A binding's targetId is opaque text (it spans four unrelated tables), so
 * existence has to be checked per targetType against the table that owns
 * that kind of id. Grouping by type keeps this to one query per type
 * present in the batch instead of one query per binding.
 */
async function assertBindingTargetsBelongToCompany(
  db: Db,
  companyId: string,
  bindings: ProjectBindingInput[],
): Promise<void> {
  const idsByType = new Map<ProjectBindingTargetTypeValue, Set<string>>();
  for (const binding of bindings) {
    const set = idsByType.get(binding.targetType) ?? new Set<string>();
    set.add(binding.targetId);
    idsByType.set(binding.targetType, set);
  }

  for (const [targetType, idSet] of idsByType) {
    const ids = [...idSet];
    let foundIds: Set<string>;
    switch (targetType) {
      case "agent": {
        const rows = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)));
        foundIds = new Set(rows.map((row) => row.id));
        break;
      }
      case "tool_connection": {
        const rows = await db
          .select({ id: toolConnections.id })
          .from(toolConnections)
          .where(and(eq(toolConnections.companyId, companyId), inArray(toolConnections.id, ids)));
        foundIds = new Set(rows.map((row) => row.id));
        break;
      }
      case "skill": {
        const rows = await db
          .select({ id: companySkills.id })
          .from(companySkills)
          .where(and(eq(companySkills.companyId, companyId), inArray(companySkills.id, ids)));
        foundIds = new Set(rows.map((row) => row.id));
        break;
      }
      case "document": {
        const rows = await db
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.companyId, companyId), inArray(documents.id, ids)));
        foundIds = new Set(rows.map((row) => row.id));
        break;
      }
    }
    const unknown = ids.filter((id) => !foundIds.has(id));
    if (unknown.length > 0) {
      throw unprocessable(`Unknown ${targetType} id(s) for this company: ${unknown.join(", ")}`, {
        targetType,
        unknownTargetIds: unknown,
      });
    }
  }
}

function bindingKey(binding: Pick<ProjectBindingInput, "projectId" | "targetType" | "targetId">): string {
  return `${binding.projectId}:${binding.targetType}:${binding.targetId}`;
}

function dedupeBindings(bindings: ProjectBindingInput[]): ProjectBindingInput[] {
  const seen = new Map<string, ProjectBindingInput>();
  for (const binding of bindings) seen.set(bindingKey(binding), binding);
  return [...seen.values()];
}

export function projectAccessService(db: Db) {
  return {
    listCategories: (companyId: string) =>
      db
        .select()
        .from(projectCategories)
        .where(eq(projectCategories.companyId, companyId))
        .orderBy(asc(projectCategories.sortOrder), asc(projectCategories.name)),

    getCategoryById: (id: string) =>
      db
        .select()
        .from(projectCategories)
        .where(eq(projectCategories.id, id))
        .then((rows) => rows[0] ?? null),

    createCategory: async (companyId: string, data: { name: string; sortOrder?: number }) => {
      try {
        return await db
          .insert(projectCategories)
          .values({ companyId, name: data.name, sortOrder: data.sortOrder ?? 0 })
          .returning()
          .then((rows) => rows[0]);
      } catch (error) {
        if (isUniqueViolation(error, "project_categories_company_name_uq")) {
          throw conflict(`A project category named "${data.name}" already exists`, { name: data.name });
        }
        throw error;
      }
    },

    updateCategory: async (id: string, data: { name?: string; sortOrder?: number }) => {
      try {
        return await db
          .update(projectCategories)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(projectCategories.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      } catch (error) {
        if (isUniqueViolation(error, "project_categories_company_name_uq")) {
          throw conflict(`A project category named "${data.name}" already exists`, { name: data.name });
        }
        throw error;
      }
    },

    /** Clears `projects.category_id` for every project in the category before deleting it — the FK has no ON DELETE action. */
    deleteCategory: (id: string) =>
      db.transaction(async (tx) => {
        const category = await tx
          .select()
          .from(projectCategories)
          .where(eq(projectCategories.id, id))
          .then((rows) => rows[0] ?? null);
        if (!category) return null;
        await tx
          .update(projects)
          .set({ categoryId: null, updatedAt: new Date() })
          .where(eq(projects.categoryId, id));
        await tx.delete(projectCategories).where(eq(projectCategories.id, id));
        return category;
      }),

    listBindings: (companyId: string) =>
      db.select().from(projectBindings).where(eq(projectBindings.companyId, companyId)),

    /** Replaces the company's whole binding set with `requested`, diffing against what already exists. */
    putBindings: async (companyId: string, requested: ProjectBindingInput[], createdByUserId: string) => {
      const uniqueRequested = dedupeBindings(requested);
      await assertProjectsBelongToCompany(
        db,
        companyId,
        [...new Set(uniqueRequested.map((binding) => binding.projectId))],
      );
      await assertBindingTargetsBelongToCompany(db, companyId, uniqueRequested);

      return db.transaction(async (tx) => {
        const existing = await tx.select().from(projectBindings).where(eq(projectBindings.companyId, companyId));
        const requestedKeys = new Set(uniqueRequested.map(bindingKey));
        const existingKeys = new Set(existing.map(bindingKey));

        const toDelete = existing.filter((binding) => !requestedKeys.has(bindingKey(binding)));
        const toInsert = uniqueRequested.filter((binding) => !existingKeys.has(bindingKey(binding)));

        for (const binding of toDelete) {
          await tx.delete(projectBindings).where(eq(projectBindings.id, binding.id));
        }
        if (toInsert.length > 0) {
          await tx.insert(projectBindings).values(
            toInsert.map((binding) => ({
              companyId,
              projectId: binding.projectId,
              targetType: binding.targetType,
              targetId: binding.targetId,
              createdByUserId,
            })),
          );
        }
        return tx.select().from(projectBindings).where(eq(projectBindings.companyId, companyId));
      });
    },

    isActiveCompanyMember: (companyId: string, userId: string) =>
      db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows.length > 0),

    getAccessGrant: (companyId: string, userId: string) =>
      db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "user"),
            eq(principalPermissionGrants.principalId, userId),
            eq(principalPermissionGrants.permissionKey, PROJECTS_ACCESS_PERMISSION_KEY),
          ),
        )
        .then((rows) => rows[0] ?? null),

    /** Upsert on the grant's unique index, so a repeated PUT with the same scope is a no-op — required to be idempotent. */
    putAccessGrant: async (
      companyId: string,
      userId: string,
      scope: ProjectAccessGrantScope,
      grantedByUserId: string | null,
    ) => {
      if (scope) {
        await assertProjectsBelongToCompany(db, companyId, scope.projectIds ?? []);
        await assertCategoriesBelongToCompany(db, companyId, scope.categoryIds ?? []);
      }
      return db
        .insert(principalPermissionGrants)
        .values({
          companyId,
          principalType: "user",
          principalId: userId,
          permissionKey: PROJECTS_ACCESS_PERMISSION_KEY,
          scope,
          grantedByUserId,
        })
        .onConflictDoUpdate({
          target: [
            principalPermissionGrants.companyId,
            principalPermissionGrants.principalType,
            principalPermissionGrants.principalId,
            principalPermissionGrants.permissionKey,
          ],
          set: { scope, grantedByUserId, updatedAt: new Date() },
        })
        .returning()
        .then((rows) => rows[0]);
    },

    deleteAccessGrant: (companyId: string, userId: string) =>
      db
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "user"),
            eq(principalPermissionGrants.principalId, userId),
            eq(principalPermissionGrants.permissionKey, PROJECTS_ACCESS_PERMISSION_KEY),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}

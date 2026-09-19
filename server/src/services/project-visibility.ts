import { and, eq, exists, inArray, isNull, not, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  caseDocuments,
  cases,
  companyMemberships,
  issueDocuments,
  issues,
  pipelineDocuments,
  pipelines,
  principalPermissionGrants,
  projectBindings,
  projects,
  routineDocuments,
  routines,
  type Db,
} from "@paperclipai/db";
import type { PermissionKey, PrincipalType, ProjectBindingTargetType } from "@paperclipai/shared";

export type ProjectAccessMode = "off" | "shadow" | "enforce";

export function projectAccessMode(): ProjectAccessMode {
  const raw = process.env.PAPERCLIP_PROJECT_ACCESS_MODE?.trim().toLowerCase();
  if (raw === "shadow") return "shadow";
  if (raw === "enforce") return "enforce";
  return "off";
}

export type ProjectVisibilityDecision = {
  allowed: boolean;
  reason: string;
  mode: ProjectAccessMode;
};

export type ProjectVisibilityActorWithMemo = {
  __projectVisibilityMemo?: Map<string, Promise<unknown>>;
};

// Caches on the actor object itself so the memo lives no longer than the
// request/actor it was built for, and evicts on rejection so a failed lookup
// can be retried.
export function getOrCreateProjectVisibilityMemo<T>(
  actor: ProjectVisibilityActorWithMemo,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  actor.__projectVisibilityMemo ??= new Map();
  const memo = actor.__projectVisibilityMemo;

  const cached = memo.get(key);
  if (cached) return cached as Promise<T>;

  const promise = load();
  memo.set(key, promise);
  void promise.catch(() => {
    if (memo.get(key) === promise) {
      memo.delete(key);
    }
  });
  return promise;
}

const PROJECTS_ACCESS_PERMISSION_KEY: PermissionKey = "projects:access";

// Owners and admins, and the local implicit board actor, always see every
// project regardless of any `projects:access` grant — matching how those
// actors already bypass every other permission check in authorization.ts.
const UNRESTRICTED_MEMBERSHIP_ROLES = new Set(["owner", "admin"]);

export type ProjectVisibilityActor = {
  companyId: string;
  principalType: PrincipalType;
  principalId: string;
  isLocalImplicit?: boolean;
} & ProjectVisibilityActorWithMemo;

export type ProjectVisibilityResolution =
  | { kind: "unrestricted" }
  | { kind: "restricted"; projectIds: Set<string> };

export const UNRESTRICTED_PROJECT_VISIBILITY: ProjectVisibilityResolution = { kind: "unrestricted" };

function scopeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Resolves which projects an actor can see. This is the single source of
 * truth: point checks test membership in the returned set, and the SQL
 * layer builds predicates from it via `projectColumnPredicate`,
 * `boundEntityPredicate` and `documentVisibilityPredicate`.
 *
 * Memoized per actor object (see `getOrCreateProjectVisibilityMemo`) so a
 * request that resolves visibility more than once for the same actor hits
 * the database once. Category membership is still evaluated fresh on every
 * call that isn't served from that memo, so a project moved into a granted
 * category becomes visible on the next unmemoized resolve.
 */
export async function resolveProjectVisibility(
  db: Db,
  actor: ProjectVisibilityActor,
): Promise<ProjectVisibilityResolution> {
  if (projectAccessMode() === "off") return UNRESTRICTED_PROJECT_VISIBILITY;
  if (actor.isLocalImplicit) return UNRESTRICTED_PROJECT_VISIBILITY;

  return getOrCreateProjectVisibilityMemo(actor, "resolveProjectVisibility", async () => {
    const membership = await db
      .select({ membershipRole: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, actor.companyId),
          eq(companyMemberships.principalType, actor.principalType),
          eq(companyMemberships.principalId, actor.principalId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (membership && UNRESTRICTED_MEMBERSHIP_ROLES.has(membership.membershipRole ?? "")) {
      return UNRESTRICTED_PROJECT_VISIBILITY;
    }

    const grant = await db
      .select({ scope: principalPermissionGrants.scope })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, actor.companyId),
          eq(principalPermissionGrants.principalType, actor.principalType),
          eq(principalPermissionGrants.principalId, actor.principalId),
          eq(principalPermissionGrants.permissionKey, PROJECTS_ACCESS_PERMISSION_KEY),
        ),
      )
      .then((rows) => rows[0] ?? null);

    // No grant at all is a hard deny: nothing is visible until one is
    // provisioned. This only bites principals created after the day-one
    // backfill (see 0280_good_vision.sql), which gave every active user a
    // null-scope (unrestricted) grant so existing behaviour didn't change.
    if (!grant) {
      return { kind: "restricted", projectIds: new Set() };
    }
    if (!grant.scope || Object.keys(grant.scope).length === 0) {
      return UNRESTRICTED_PROJECT_VISIBILITY;
    }

    const scope = grant.scope as { categoryIds?: unknown; projectIds?: unknown };
    const projectIds = new Set(scopeIdList(scope.projectIds));
    const categoryIds = scopeIdList(scope.categoryIds);
    if (categoryIds.length > 0) {
      const categoryProjects = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, actor.companyId), inArray(projects.categoryId, categoryIds)));
      for (const row of categoryProjects) projectIds.add(row.id);
    }

    return { kind: "restricted", projectIds };
  });
}

/** SQL predicate for a nullable `project_id` column (issues, routines, pipelines, cases, ...). */
export function projectColumnPredicate(
  resolution: ProjectVisibilityResolution,
  projectIdColumn: AnyPgColumn,
): SQL {
  if (resolution.kind === "unrestricted") return sql`true`;
  if (resolution.projectIds.size === 0) return isNull(projectIdColumn);
  return or(isNull(projectIdColumn), inArray(projectIdColumn, [...resolution.projectIds]))!;
}

/**
 * SQL predicate for an entity governed by `project_bindings` (agent,
 * tool_connection, skill, document). An entity with no binding row is
 * unrestricted — bindings only ever narrow, they never hide something that
 * was never bound to a project.
 */
export function boundEntityPredicate(
  db: Db,
  resolution: ProjectVisibilityResolution,
  companyId: string,
  targetType: ProjectBindingTargetType,
  targetIdColumn: AnyPgColumn,
): SQL {
  if (resolution.kind === "unrestricted") return sql`true`;

  const visibleProjectIds = [...resolution.projectIds];
  const bindingRowExists = exists(
    db
      .select({ id: projectBindings.id })
      .from(projectBindings)
      .where(
        and(
          eq(projectBindings.companyId, companyId),
          eq(projectBindings.targetType, targetType),
          eq(projectBindings.targetId, sql`${targetIdColumn}::text`),
        ),
      ),
  );
  const boundToVisibleProject = exists(
    db
      .select({ id: projectBindings.id })
      .from(projectBindings)
      .where(
        and(
          eq(projectBindings.companyId, companyId),
          eq(projectBindings.targetType, targetType),
          eq(projectBindings.targetId, sql`${targetIdColumn}::text`),
          visibleProjectIds.length === 0 ? sql`false` : inArray(projectBindings.projectId, visibleProjectIds),
        ),
      ),
  );

  return or(not(bindingRowExists), boundToVisibleProject)!;
}

/**
 * SQL predicate for `documents.id` covering every way a document inherits
 * (or escapes) project scoping:
 *  - explicit `project_bindings` row (freestanding documents)
 *  - owned by an issue, routine, pipeline or case, scoped via that owner's
 *    (nullable) `project_id`
 *  - unowned and unbound documents, which stay visible the same way a
 *    resource with no attributable project always does
 */
export function documentVisibilityPredicate(
  db: Db,
  resolution: ProjectVisibilityResolution,
  companyId: string,
  documentIdColumn: AnyPgColumn,
): SQL {
  if (resolution.kind === "unrestricted") return sql`true`;

  const visibleProjectIds = [...resolution.projectIds];
  const projectFilter = (projectIdColumn: AnyPgColumn) =>
    visibleProjectIds.length === 0
      ? isNull(projectIdColumn)
      : or(isNull(projectIdColumn), inArray(projectIdColumn, visibleProjectIds))!;

  const issueLinkExists = exists(
    db
      .select({ id: issueDocuments.id })
      .from(issueDocuments)
      .where(and(eq(issueDocuments.documentId, documentIdColumn), eq(issueDocuments.companyId, companyId))),
  );
  const routineLinkExists = exists(
    db
      .select({ id: routineDocuments.id })
      .from(routineDocuments)
      .where(and(eq(routineDocuments.documentId, documentIdColumn), eq(routineDocuments.companyId, companyId))),
  );
  const pipelineLinkExists = exists(
    db
      .select({ id: pipelineDocuments.id })
      .from(pipelineDocuments)
      .where(and(eq(pipelineDocuments.documentId, documentIdColumn), eq(pipelineDocuments.companyId, companyId))),
  );
  const caseLinkExists = exists(
    db
      .select({ id: caseDocuments.id })
      .from(caseDocuments)
      .where(and(eq(caseDocuments.documentId, documentIdColumn), eq(caseDocuments.companyId, companyId))),
  );
  const bindingLinkExists = exists(
    db
      .select({ id: projectBindings.id })
      .from(projectBindings)
      .where(
        and(
          eq(projectBindings.companyId, companyId),
          eq(projectBindings.targetType, "document" satisfies ProjectBindingTargetType),
          eq(projectBindings.targetId, sql`${documentIdColumn}::text`),
        ),
      ),
  );
  const hasAnyLink = or(issueLinkExists, routineLinkExists, pipelineLinkExists, caseLinkExists, bindingLinkExists)!;

  const issueOwnerVisible = exists(
    db
      .select({ id: issueDocuments.id })
      .from(issueDocuments)
      .innerJoin(issues, eq(issues.id, issueDocuments.issueId))
      .where(
        and(
          eq(issueDocuments.documentId, documentIdColumn),
          eq(issueDocuments.companyId, companyId),
          projectFilter(issues.projectId),
        ),
      ),
  );
  const routineOwnerVisible = exists(
    db
      .select({ id: routineDocuments.id })
      .from(routineDocuments)
      .innerJoin(routines, eq(routines.id, routineDocuments.routineId))
      .where(
        and(
          eq(routineDocuments.documentId, documentIdColumn),
          eq(routineDocuments.companyId, companyId),
          projectFilter(routines.projectId),
        ),
      ),
  );
  const pipelineOwnerVisible = exists(
    db
      .select({ id: pipelineDocuments.id })
      .from(pipelineDocuments)
      .innerJoin(pipelines, eq(pipelines.id, pipelineDocuments.pipelineId))
      .where(
        and(
          eq(pipelineDocuments.documentId, documentIdColumn),
          eq(pipelineDocuments.companyId, companyId),
          projectFilter(pipelines.projectId),
        ),
      ),
  );
  const caseOwnerVisible = exists(
    db
      .select({ id: caseDocuments.id })
      .from(caseDocuments)
      .innerJoin(cases, eq(cases.id, caseDocuments.caseId))
      .where(
        and(
          eq(caseDocuments.documentId, documentIdColumn),
          eq(caseDocuments.companyId, companyId),
          projectFilter(cases.projectId),
        ),
      ),
  );
  const bindingVisible = exists(
    db
      .select({ id: projectBindings.id })
      .from(projectBindings)
      .where(
        and(
          eq(projectBindings.companyId, companyId),
          eq(projectBindings.targetType, "document" satisfies ProjectBindingTargetType),
          eq(projectBindings.targetId, sql`${documentIdColumn}::text`),
          visibleProjectIds.length === 0 ? sql`false` : inArray(projectBindings.projectId, visibleProjectIds),
        ),
      ),
  );

  return or(
    not(hasAnyLink),
    issueOwnerVisible,
    routineOwnerVisible,
    pipelineOwnerVisible,
    caseOwnerVisible,
    bindingVisible,
  )!;
}

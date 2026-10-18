import { and, eq } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import {
  agents,
  heartbeatRuns,
  issues,
  projects,
  runIdentityContexts,
  type Db,
} from "@paperclipai/db";
import { githubIdentityEnvKey } from "@paperclipai/adapter-utils/github-launcher";
import { parseObject } from "../adapters/utils.js";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import {
  buildGitAuthInvocation,
  resolveManagedGitHubCredential,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  source?: "personal" | "dedicated";
  login?: string;
  reason?: string;
  connectionId?: string;
  grantId?: string;
  authenticationMode?: "managed" | "host" | "anonymous";
};

/** A raw GitHub token cannot enforce the low-trust read-only tool boundary. */
async function allowsGitHubCredentialExport(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const issueId =
    run.contextSnapshot?.issueId ??
    run.contextSnapshot?.taskId ??
    run.nativeIssueId;
  if (
    issueId !== undefined &&
    issueId !== null &&
    (typeof issueId !== "string" || !isUuidLike(issueId))
  )
    return false;
  const [agent] = await db
    .select({ companyId: agents.companyId, permissions: agents.permissions })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)),
    );
  if (!agent) return false;
  const [issue] =
    typeof issueId === "string"
      ? await db
          .select({
            companyId: issues.companyId,
            projectId: issues.projectId,
            executionPolicy: issues.executionPolicy,
            sourceTrust: issues.sourceTrust,
          })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
      : [];
  if (issueId !== undefined && issueId !== null && !issue) return false;
  if (isLowTrustQuarantined(issue?.sourceTrust)) return false;
  const projectId = issue?.projectId ?? run.contextSnapshot?.projectId;
  if (
    projectId !== undefined &&
    projectId !== null &&
    (typeof projectId !== "string" || !isUuidLike(projectId))
  )
    return false;
  const [project] =
    typeof projectId === "string"
      ? await db
          .select({
            companyId: projects.companyId,
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.companyId, run.companyId),
            ),
          )
      : [];
  if (projectId !== undefined && projectId !== null && !project) return false;
  return (
    resolveCoreTrustPreset({
      companyId: run.companyId,
      agent,
      project,
      issue,
      run: {
        companyId: run.companyId,
        executionPolicy: run.contextSnapshot?.executionPolicy,
      },
    }).kind === "standard"
  );
}

/**
 * Resolve the agent's `<NAME>_GH_TOKEN` env binding (agent first, then the run's
 * project) for one GitHub command. Managed runs never receive these bindings in
 * their environment, so this is the only place the value is decrypted.
 */
async function resolveNamedGitHubIdentity(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  identity: string,
  responsibleUserId: string | null,
): Promise<{ summary: GitHubCredentialSummary; env: Record<string, string> }> {
  const envKey = githubIdentityEnvKey(identity);
  if (!envKey) {
    return { summary: { status: "unavailable", reason: "Invalid GitHub identity name" }, env: {} };
  }
  const issueId =
    typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null;
  const [agent] = await db
    .select({ adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
  let binding = parseObject(agent?.adapterConfig?.env)[envKey];
  let consumer: { consumerType: "agent" | "project"; consumerId: string } = {
    consumerType: "agent",
    consumerId: run.agentId,
  };
  if (binding === undefined) {
    const [issue] = issueId
      ? await db
          .select({ projectId: issues.projectId })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      : [];
    const projectId =
      issue?.projectId ??
      (typeof run.contextSnapshot?.projectId === "string" ? run.contextSnapshot.projectId : null);
    const [project] = projectId
      ? await db
          .select({ env: projects.env })
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.companyId, run.companyId)))
      : [];
    binding = parseObject(project?.env)[envKey];
    if (binding !== undefined && projectId) {
      consumer = { consumerType: "project", consumerId: projectId };
    }
  }
  if (binding === undefined) {
    return {
      summary: { status: "absent", reason: `No ${envKey} binding on this agent or its project` },
      env: {},
    };
  }
  const resolved = await secretService(db).resolveEnvBindings(
    run.companyId,
    { [envKey]: binding },
    {
      ...consumer,
      actorType: "agent",
      actorId: run.agentId,
      responsibleUserId,
      issueId,
      heartbeatRunId: run.id,
    },
  );
  const token = resolved.env[envKey];
  if (!token) {
    return { summary: { status: "unavailable", reason: `${envKey} resolved to an empty value` }, env: {} };
  }
  return {
    summary: { status: "available", authenticationMode: "managed" },
    env: buildGitAuthInvocation({ token, source: "company_secret", secretName: envKey }).env,
  };
}

/**
 * Without `identity`, no company secrets or ambient credentials are consulted.
 * With `identity`, only the agent's own `<NAME>_GH_TOKEN` binding is.
 */
export async function resolveGitHubOperationCredentials(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    /** Selects the agent's `<NAME>_GH_TOKEN` binding instead of the managed identity. */
    identity?: string;
  },
) {
  const { run, context } = await captureRunIdentity(db, input);
  if (!context) throw forbidden("This run predates managed GitHub credentials");
  let summary: GitHubCredentialSummary;
  let env: Record<string, string> = {};
  // A sponsored guest's responsible person is an internal accountability field,
  // not authorization to export that person's (or a dedicated bot's) token.
  // Re-read every policy source for each operation, including a run's retained
  // boundary after task policy edits. Deny before touching the credential store.
  if (!(await allowsGitHubCredentialExport(db, run))) {
    summary = {
      status: "unavailable",
      reason:
        "GitHub credentials are not available to low-trust or unverified executions; use authorized read-only tools.",
    };
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
    return {
      identityContextId: context.id,
      revision: context.revision,
      ...summary,
      env,
    };
  }
  if (input.identity !== undefined) {
    // A named identity is an operation-scoped override. It does not replace the
    // run's recorded managed identity, so runIdentityContexts is left untouched.
    let named: { summary: GitHubCredentialSummary; env: Record<string, string> };
    try {
      named = await resolveNamedGitHubIdentity(
        db,
        run,
        input.identity,
        context.cause === "company_default" ? null : (context.responsibleUserId ?? null),
      );
    } catch {
      // Secret-store errors can carry sensitive detail. Never return them.
      named = {
        summary: { status: "unavailable", reason: "GitHub credentials are temporarily unavailable" },
        env: {},
      };
    }
    return {
      identityContextId: context.id,
      revision: context.revision,
      ...named.summary,
      env: named.env,
    };
  }
  try {
    const resolved = await resolveManagedGitHubCredential(
      db,
      secretService(db),
      input.companyId,
      {
        agentId: input.agentId,
        heartbeatRunId: input.runId,
        allowStandingDelegation: false,
        responsibleUserId:
          context?.cause === "company_default"
            ? null
            : (context?.responsibleUserId ?? null),
        issueId:
          typeof run.contextSnapshot?.issueId === "string"
            ? run.contextSnapshot.issueId
            : null,
      },
    );
    if (resolved.credential) {
      summary = {
        status: "available",
        source: resolved.credential.identitySource,
        login: resolved.credential.githubIdentity?.login,
        connectionId: resolved.credential.connectionId,
        grantId: resolved.credential.grantId,
        authenticationMode: "managed",
      };
      env = buildGitAuthInvocation(resolved.credential).env;
    } else {
      summary = {
        status: resolved.configured ? "unavailable" : "absent",
        source: resolved.identitySource ?? "personal",
        reason: resolved.error ?? "No GitHub identity connected",
      };
    }
  } catch {
    // Provider/secret errors can contain sensitive response bodies. Never persist them.
    summary = {
      status: "unavailable",
      reason: "GitHub credentials are temporarily unavailable",
    };
  }
  if (context)
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
  return {
    identityContextId: context?.id ?? null,
    revision: context?.revision ?? null,
    ...summary,
    env,
  };
}

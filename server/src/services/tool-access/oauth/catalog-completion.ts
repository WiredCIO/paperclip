import { connectionActorUserId } from "../actor.js";
import type { ActorInfo } from "../types.js";
import { isRemoteMcpConnectorMethod } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, issueThreadInteractions, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import type { ConnectToolAppResult, FinishToolApp, ToolCatalogEntry } from "@paperclipai/shared";

import type { FinishConnectionSetup } from "../catalog/contracts.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

/**
 * CH-3: a connection revived after removal keeps its id, and `removeConnection`
 * revokes (never deletes) its grant rows -- so a *revoked* grant proves this
 * connection was actually removed before, not merely mid-setup. Checking for
 * any grant regardless of status is too broad: a setup attempt that fails
 * partway through can leave an active grant behind on a connection that was
 * never active. Callers must run this before writing the current callback's
 * own grant, or that write would make every connection look pre-existing.
 */
export async function connectionHasPriorGrant(
  db: Db,
  connection: Pick<typeof toolConnections.$inferSelect, "id" | "companyId">,
): Promise<boolean> {
  const [revokedGrant] = await db
    .select({ id: connectionGrants.id })
    .from(connectionGrants)
    .where(
      and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.status, "revoked"),
      ),
    )
    .limit(1);
  return Boolean(revokedGrant);
}

export function createOAuthCatalogCompletion(db: Db, finishGalleryAppConnection: FinishConnectionSetup) {
  async function finishOAuthCatalogWithRecommendedDefaults(input: {
    connection: typeof toolConnections.$inferSelect;
    catalog: ToolCatalogEntry[];
    suggestedDefaults: ConnectToolAppResult["suggestedDefaults"];
    activateQuarantined?: boolean;
    actor?: ActorInfo;
    interactionId?: string | null;
    /**
     * CH-3: `installs.length === 0` is not proof a connection is new -- removing
     * one revokes its grants and deletes its installs, so a connection revived
     * afterward reaches this function with the same empty installs a brand-new
     * one has. The caller must say which one this is from state it read before
     * writing this callback's own grant. Only a genuinely new connection gets
     * its named agents seeded; a reconnect leaves installs alone, even when empty.
     */
    isNewConnection: boolean;
  }) {
    const linkedInteraction = input.interactionId
      ? await db
          .select({ kind: issueThreadInteractions.kind })
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.id, input.interactionId),
              eq(issueThreadInteractions.companyId, input.connection.companyId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    // A task callback only prepares the catalog. The intent completion transaction
    // validates current ownership and adds the requesting agent's access.
    const deferTaskAccess = linkedInteraction?.kind === "connection_intent";
    const installs = await db
      .select()
      .from(toolConnectionInstalls)
      .where(
        and(
          eq(toolConnectionInstalls.companyId, input.connection.companyId),
          eq(toolConnectionInstalls.connectionId, input.connection.id),
        ),
      );
    const companyInstall = installs.some(
      (install) => install.targetType === "company",
    );
    const agentIds = installs
      .filter((install) => install.targetType === "agent")
      .map((install) => install.targetId);
    const suggestedAccessRecord = asRecord(input.suggestedDefaults.access);
    const suggestedAgentIds = Array.isArray(suggestedAccessRecord.agentIds)
      ? suggestedAccessRecord.agentIds.filter(
          (agentId): agentId is string => typeof agentId === "string",
        )
      : [];
    // A callback seeds reach only for agents someone named (the dedicated or
    // subject agent). Company-wide reach is an operator choice: the wizard's
    // Access step commits it through finishApp + putConnectionInstalls after
    // this callback. A connection created through the API names no agent, and
    // defaulting it to every agent mounted one client's Dataverse into another
    // client's agent.
    const normalizedSuggestedAccess: FinishToolApp["access"] =
      suggestedAgentIds.length > 0
        ? { agentIds: suggestedAgentIds }
        : { agentIds: [] };
    // Workspace setup saves the operator's install selection before OAuth too.
    // An empty selection means no agents, not permission to apply all-agent
    // defaults after the user returns from Google.
    const preserveEmptyInstalls = input.connection.config.sourceTemplateKey === "google-workspace"
      || isRemoteMcpConnectorMethod(
      input.connection.config.sourceTemplateKey,
      input.connection.config.connectionMethodKey,
    ) || (input.connection.transport === "mcp_remote"
      && input.connection.config.mcpAgentAccessConfigured === true);
    // CH-3: finishGalleryAppConnection now saves profile bindings and installs
    // together from `access`, so a reconnect of a connection with no installs
    // must pass no access at all; the seeded default below is for new
    // connections only.
    const access: FinishToolApp["access"] = deferTaskAccess
      ? { agentIds: [] }
      : installs.length === 0
        ? preserveEmptyInstalls || !input.isNewConnection ? { agentIds: [] } : normalizedSuggestedAccess
        : companyInstall
          ? "all_agents"
          : { agentIds };
    const askFirstRiskLevels = new Set(
      Array.isArray(input.suggestedDefaults.askFirstRiskLevels)
        ? input.suggestedDefaults.askFirstRiskLevels.filter(
            (riskLevel): riskLevel is string => typeof riskLevel === "string",
          )
        : [],
    );
    const enabledCatalog = input.catalog.filter(
      (entry) =>
        entry.status === "active" ||
        (input.activateQuarantined === true && entry.status === "quarantined"),
    );
    const finished = await finishGalleryAppConnection(
      input.connection.companyId,
      input.connection.id,
      {
        enabledCatalogEntryIds: enabledCatalog.map((entry) => entry.id),
        askFirstCatalogEntryIds: enabledCatalog
          .filter((entry) => askFirstRiskLevels.has(entry.riskLevel))
          .map((entry) => entry.id),
        reviewedCatalogEntryIds:
          input.activateQuarantined === true
            ? enabledCatalog
                .filter((entry) => entry.status === "quarantined")
                .map((entry) => entry.id)
            : undefined,
        access,
        preserveExistingAccess: deferTaskAccess,
      },
      input.actor,
    );
    if (!deferTaskAccess && !preserveEmptyInstalls && input.isNewConnection && installs.length === 0) {
      const installTargets =
        access === "all_agents"
          ? [
              {
                targetType: "company" as const,
                targetId: input.connection.companyId,
              },
            ]
          : [...new Set(access.agentIds)].map((agentId) => ({
              targetType: "agent" as const,
              targetId: agentId,
            }));
      if (installTargets.length > 0) {
        await db
          .insert(toolConnectionInstalls)
          .values(
            installTargets.map((target) => ({
              companyId: input.connection.companyId,
              connectionId: input.connection.id,
              ...target,
              createdByAgentId:
                input.actor?.actorType === "agent"
                  ? (input.actor.actorId ?? null)
                  : null,
              createdByUserId:
                connectionActorUserId(input.actor),
            })),
          )
          .onConflictDoNothing();
      }
    }
    return finished;
  }
  return finishOAuthCatalogWithRecommendedDefaults;
}
export type OAuthCatalogCompletion = ReturnType<typeof createOAuthCatalogCompletion>;

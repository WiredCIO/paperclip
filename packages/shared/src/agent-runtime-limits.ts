/**
 * CH-17: the run limits every local adapter shares, resolved in one place.
 *
 * Before this, `maxTurnsPerRun` was a `claude_local` seeding rule and every
 * adapter read its own `adapterConfig.maxTurns`, where `0` meant uncapped and
 * unset also meant uncapped. `agentRuntimeConfigSchema` validated none of it.
 * The result was agents with no cap at all: S4Water burned turns rediscovering
 * its tools, and an earlier agent spent 7.9M input tokens in 89 minutes.
 *
 * The defaults below are therefore real defaults, not sentinels. An agent that
 * configures nothing gets a bounded run, and removing the turn cap takes an
 * explicit `unlimited: true` rather than an easily-missed `0`.
 */

/** Applied when neither the agent nor its company says otherwise. */
export const DEFAULT_AGENT_RUNTIME_LIMITS = {
  maxTurnsPerRun: 40,
  runTimeoutSec: 1800,
  mcpToolTimeoutSec: 120,
} as const;

/** What a run actually enforces. `null` for the turn cap means uncapped. */
export interface ResolvedAgentRuntimeLimits {
  maxTurnsPerRun: number | null;
  runTimeoutSec: number;
  mcpToolTimeoutSec: number;
}

/** A configured limits block, from an agent or a company default. */
export interface AgentRuntimeLimitsInput {
  maxTurnsPerRun?: number | null;
  runTimeoutSec?: number | null;
  mcpToolTimeoutSec?: number | null;
  /**
   * Removes the turn cap, and only the turn cap. `runTimeoutSec` still bounds
   * the run: an agent with neither a turn cap nor a timeout is precisely the
   * failure this issue exists to prevent, so there is deliberately no single
   * switch that removes both.
   */
  unlimited?: boolean;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : null;
}

/**
 * Reads a legacy per-adapter turn cap out of `adapterConfig`. Adapters spelled
 * this `maxTurns`; `0` meant uncapped, and so did absent.
 */
export function readLegacyAdapterMaxTurns(
  adapterConfig: unknown,
): { present: boolean; maxTurnsPerRun: number | null } {
  if (adapterConfig === null || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) {
    return { present: false, maxTurnsPerRun: null };
  }
  const record = adapterConfig as Record<string, unknown>;
  // Adapters spelled this two ways: `maxTurns` (grok and friends) and
  // `maxTurnsPerRun` (claude_local). Both are legacy per-agent caps and both
  // must be honoured, or migrating one adapter silently re-caps the other.
  const raw = typeof record.maxTurns === "number" ? record.maxTurns : record.maxTurnsPerRun;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { present: false, maxTurnsPerRun: null };
  // 0 was the documented "uncapped" spelling, so it is present-and-uncapped
  // rather than absent. Preserving that distinction is what stops the
  // migration silently imposing a cap on an agent that opted out.
  return { present: true, maxTurnsPerRun: positiveInteger(raw) };
}

/**
 * Reads the typed `limits` block out of an agent's `runtimeConfig`. Returns
 * null for every shape that does not carry one, so a config typo falls back to
 * the defaults rather than failing a run.
 */
export function readAgentRuntimeLimits(runtimeConfig: unknown): AgentRuntimeLimitsInput | null {
  if (runtimeConfig === null || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) {
    return null;
  }
  const raw = (runtimeConfig as Record<string, unknown>).limits;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return {
    maxTurnsPerRun: typeof record.maxTurnsPerRun === "number" ? record.maxTurnsPerRun : null,
    runTimeoutSec: typeof record.runTimeoutSec === "number" ? record.runTimeoutSec : null,
    mcpToolTimeoutSec:
      typeof record.mcpToolTimeoutSec === "number" ? record.mcpToolTimeoutSec : null,
    unlimited: record.unlimited === true,
  };
}

/**
 * Resolves the limits for one run.
 *
 * Precedence, strongest first: the agent's own `limits`, then a legacy
 * `adapterConfig.maxTurns` (also an explicit per-agent choice), then the
 * company default, then {@link DEFAULT_AGENT_RUNTIME_LIMITS}.
 */
export function resolveAgentRuntimeLimits(input: {
  agent?: AgentRuntimeLimitsInput | null;
  company?: AgentRuntimeLimitsInput | null;
  /** The agent's `adapterConfig`, read only for the legacy `maxTurns` key. */
  adapterConfig?: unknown;
}): ResolvedAgentRuntimeLimits {
  const agent = input.agent ?? null;
  const company = input.company ?? null;
  const legacy = readLegacyAdapterMaxTurns(input.adapterConfig);

  const agentMaxTurns = positiveInteger(agent?.maxTurnsPerRun);
  const companyMaxTurns = positiveInteger(company?.maxTurnsPerRun);

  const maxTurnsPerRun = (() => {
    if (agent?.unlimited === true) return null;
    if (agentMaxTurns !== null) return agentMaxTurns;
    // A legacy explicit 0 is an opt-out and outranks the company default, the
    // same way an explicit number would.
    if (legacy.present) return legacy.maxTurnsPerRun;
    if (company?.unlimited === true) return null;
    if (companyMaxTurns !== null) return companyMaxTurns;
    return DEFAULT_AGENT_RUNTIME_LIMITS.maxTurnsPerRun;
  })();

  return {
    maxTurnsPerRun,
    runTimeoutSec:
      positiveInteger(agent?.runTimeoutSec) ??
      positiveInteger(company?.runTimeoutSec) ??
      DEFAULT_AGENT_RUNTIME_LIMITS.runTimeoutSec,
    mcpToolTimeoutSec:
      positiveInteger(agent?.mcpToolTimeoutSec) ??
      positiveInteger(company?.mcpToolTimeoutSec) ??
      DEFAULT_AGENT_RUNTIME_LIMITS.mcpToolTimeoutSec,
  };
}

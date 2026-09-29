import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { DEFAULT_GROK_LOCAL_MODEL } from "../index.js";
import { DEFAULT_GROK_MCP_TOOL_TIMEOUT_SEC } from "./mcp-config.js";

/**
 * The grok_local configuration form. Without a schema the adapter's run
 * controls — the turn cap and the run timeout in particular — are reachable
 * only by editing adapterConfig directly, which is how agents end up running
 * unbounded.
 */
export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "text",
        default: DEFAULT_GROK_LOCAL_MODEL,
        hint: `Grok model id. Defaults to ${DEFAULT_GROK_LOCAL_MODEL}. Run \`grok models\` on the host to list what the seat can reach.`,
      },
      {
        key: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        default: "",
        options: [
          { value: "", label: "Grok default" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        hint: "Passed as --reasoning-effort. Leave on the Grok default unless a task needs more deliberation.",
      },
      {
        key: "maxTurns",
        label: "Max turns per run",
        type: "number",
        default: 0,
        hint: "Passed as --max-turns. 0 leaves the run uncapped, which lets a stuck agent iterate until the timeout.",
      },
      {
        key: "timeoutSec",
        label: "Run timeout (seconds)",
        type: "number",
        default: 0,
        hint: "0 means no timeout: the run can continue indefinitely. Set a bound for unattended agents.",
      },
      {
        key: "graceSec",
        label: "Termination grace (seconds)",
        type: "number",
        default: 20,
        hint: "SIGTERM grace period before the run is killed.",
      },
      {
        key: "mcpToolTimeoutSec",
        label: "MCP tool call timeout (seconds)",
        type: "number",
        default: DEFAULT_GROK_MCP_TOOL_TIMEOUT_SEC,
        hint: "Per-call bound for Paperclip's connected tools. Grok's own default is 6000, which lets one wedged call hold a run for 100 minutes.",
      },
      {
        key: "disableWebSearch",
        label: "Disable web search",
        type: "toggle",
        default: false,
        hint: "When on, the agent cannot look anything up. Leave off unless the workspace is deliberately offline.",
      },
      {
        key: "alwaysApprove",
        label: "Always approve tool calls",
        type: "toggle",
        default: true,
        hint: "Required for unattended runs. Grok denies tool calls by default without it.",
      },
      {
        key: "permissionMode",
        label: "Permission mode",
        type: "text",
        default: "",
        hint: "Passed as --permission-mode. Normally left empty: `dontAsk` overrides --always-approve and breaks unattended runs.",
      },
      {
        key: "command",
        label: "Grok command",
        type: "text",
        default: "grok",
        hint: "Executable used to launch Grok. Defaults to `grok` on PATH.",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Fallback absolute working directory when the run has no Paperclip workspace.",
      },
    ],
  };
}

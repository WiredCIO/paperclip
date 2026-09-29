import { z } from "zod";
import {
  createRoutineSchema,
  createRoutineTriggerSchema,
  updateIssueWorkProductSchema,
  updateRoutineSchema,
  updateRoutineTriggerSchema,
} from "@paperclipai/shared";
import type { PaperclipApiClient, ToolDefinition } from "@paperclipai/mcp-server";

// Tools Paperclip's own MCP server does not provide.
//
// They live here rather than in packages/mcp-server because that package's tool
// list is a frozen surface: every entry is a `legacy_mcp_alias` in the runner's
// capability ledger, pinned at 42 rows and required to fold into a capability.
// Upstream is migrating off that surface, so growing it means fighting a
// deliberate guardrail and diverging in files upstream actively maintains.
// Composing is cheaper and survives upstream merges.

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        const result = await execute(parsed);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    },
  };
}

const companyIdOptional = z.string().guid().optional().nullable();
const routineIdSchema = z.string().guid();
const routineTriggerIdSchema = z.string().guid();
const workProductIdSchema = z.string().guid();
const issueIdSchema = z.string().min(1);

const listRoutinesToolSchema = z.object({ companyId: companyIdOptional });

const createRoutineToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createRoutineSchema);

const updateRoutineToolSchema = z.object({
  routineId: routineIdSchema,
}).merge(updateRoutineSchema);

// createRoutineTriggerSchema is a discriminated union on `kind` (schedule,
// webhook, …), not an object, so it cannot be merged into the tool schema.
// Nesting it keeps the union's validation rather than flattening it into
// something looser.
const createRoutineTriggerToolSchema = z.object({
  routineId: routineIdSchema,
  trigger: createRoutineTriggerSchema,
});

const updateRoutineTriggerToolSchema = z.object({
  triggerId: routineTriggerIdSchema,
}).merge(updateRoutineTriggerSchema);

const listRoutineRunsToolSchema = z.object({
  routineId: routineIdSchema,
  limit: z.number().int().positive().max(200).optional(),
});

const updateWorkProductToolSchema = z.object({
  workProductId: workProductIdSchema,
}).merge(updateIssueWorkProductSchema);

export function createWiredcioToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  return [
    // ── Routines ────────────────────────────────────────────────────────────
    //
    // Triggers are NOT part of the routine body. Neither create nor update
    // accepts them: the server takes the routine payload, ignores any
    // `triggers` key, and returns 200. Schedules are managed only through the
    // trigger tools below. Missing that looks exactly like a routine silently
    // refusing to change its cron.
    makeTool(
      "paperclipListRoutines",
      "List routines (scheduled or triggered recurring work) for a company",
      listRoutinesToolSchema,
      async ({ companyId }) =>
        client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/routines`),
    ),
    makeTool(
      "paperclipGetRoutine",
      "Get a single routine, including its current triggers",
      z.object({ routineId: routineIdSchema }),
      async ({ routineId }) =>
        client.requestJson("GET", `/routines/${encodeURIComponent(routineId)}`),
    ),
    makeTool(
      "paperclipCreateRoutine",
      "Create a routine. This creates the routine only — add a schedule separately with "
        + "paperclipCreateRoutineTrigger, or it will never fire.",
      createRoutineToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/routines`, { body }),
    ),
    makeTool(
      "paperclipUpdateRoutine",
      "Update a routine's title, description, assignee, priority, status or policies. Does NOT "
        + "change its schedule: trigger changes sent here are ignored and still return 200. Use "
        + "paperclipUpdateRoutineTrigger for that.",
      updateRoutineToolSchema,
      async ({ routineId, ...body }) =>
        client.requestJson("PATCH", `/routines/${encodeURIComponent(routineId)}`, { body }),
    ),
    makeTool(
      "paperclipRunRoutine",
      "Run a routine immediately, outside its schedule",
      z.object({ routineId: routineIdSchema }),
      async ({ routineId }) =>
        client.requestJson("POST", `/routines/${encodeURIComponent(routineId)}/run`),
    ),
    makeTool(
      "paperclipListRoutineRuns",
      "List recent runs of a routine, to check whether it is firing and what it produced",
      listRoutineRunsToolSchema,
      async ({ routineId, limit }) => {
        const qs = limit === undefined ? "" : `?limit=${limit}`;
        return client.requestJson("GET", `/routines/${encodeURIComponent(routineId)}/runs${qs}`);
      },
    ),
    makeTool(
      "paperclipCreateRoutineTrigger",
      "Add a trigger to a routine — this is what makes it fire. Schedule triggers take a 5-field "
        + "cron expression and a timezone.",
      createRoutineTriggerToolSchema,
      async ({ routineId, trigger }) =>
        client.requestJson("POST", `/routines/${encodeURIComponent(routineId)}/triggers`, {
          body: trigger,
        }),
    ),
    makeTool(
      "paperclipUpdateRoutineTrigger",
      "Change an existing trigger — cron expression, timezone, or enabled state. This is the only "
        + "way to reschedule a routine.",
      updateRoutineTriggerToolSchema,
      async ({ triggerId, ...body }) =>
        client.requestJson("PATCH", `/routine-triggers/${encodeURIComponent(triggerId)}`, { body }),
    ),

    // ── Work products (the review surface) ──────────────────────────────────
    makeTool(
      "paperclipListIssueWorkProducts",
      "List what an issue actually produced — pull requests, documents, artifacts — with each "
        + "one's status and review state. The starting point for reviewing an agent's output.",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/work-products`),
    ),
    makeTool(
      "paperclipUpdateWorkProduct",
      "Update a work product. Set reviewState to 'approved' or 'changes_requested' to record a "
        + "review decision, or status to move it through its lifecycle.",
      updateWorkProductToolSchema,
      async ({ workProductId, ...body }) =>
        client.requestJson("PATCH", `/work-products/${encodeURIComponent(workProductId)}`, { body }),
    ),
  ];
}

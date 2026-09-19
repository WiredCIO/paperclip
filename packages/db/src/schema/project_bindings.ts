import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, check, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { ProjectBindingTargetType } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const projectBindings = pgTable(
  "project_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    targetType: text("target_type").$type<ProjectBindingTargetType>().notNull(),
    targetId: text("target_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetTypeCheck: check(
      "project_bindings_target_type_check",
      sql`${table.targetType} in ('agent', 'tool_connection', 'skill', 'document')`,
    ),
    targetIdx: index("project_bindings_target_idx").on(table.companyId, table.targetType, table.targetId),
    projectTargetUq: uniqueIndex("project_bindings_project_target_uq").on(
      table.companyId,
      table.projectId,
      table.targetType,
      table.targetId,
    ),
  }),
);

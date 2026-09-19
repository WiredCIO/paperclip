import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, check, uniqueIndex } from "drizzle-orm/pg-core";
import type { OrgEdgeParticipantType } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const orgEdges = pgTable(
  "org_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    memberType: text("member_type").$type<OrgEdgeParticipantType>().notNull(),
    memberId: text("member_id").notNull(),
    managerType: text("manager_type").$type<OrgEdgeParticipantType>().notNull(),
    managerId: text("manager_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    memberTypeCheck: check("org_edges_member_type_check", sql`${table.memberType} in ('agent', 'user')`),
    managerTypeCheck: check("org_edges_manager_type_check", sql`${table.managerType} in ('agent', 'user')`),
    notBothAgentsCheck: check(
      "org_edges_not_both_agents_check",
      sql`not (${table.memberType} = 'agent' and ${table.managerType} = 'agent')`,
    ),
    companyMemberUq: uniqueIndex("org_edges_company_member_uq").on(
      table.companyId,
      table.memberType,
      table.memberId,
    ),
  }),
);

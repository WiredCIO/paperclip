-- WiredCIO fork migration (originally 0280_good_vision on wiredcio/deploy,
-- renumbered after upstream's 0431). Production already applied the original,
-- so every statement is idempotent: re-running against an up-to-date database
-- is a no-op.
CREATE TABLE IF NOT EXISTS "org_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"member_type" text NOT NULL,
	"member_id" text NOT NULL,
	"manager_type" text NOT NULL,
	"manager_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_edges_member_type_check" CHECK ("org_edges"."member_type" in ('agent', 'user')),
	CONSTRAINT "org_edges_manager_type_check" CHECK ("org_edges"."manager_type" in ('agent', 'user')),
	CONSTRAINT "org_edges_not_both_agents_check" CHECK (not ("org_edges"."member_type" = 'agent' and "org_edges"."manager_type" = 'agent'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_bindings_target_type_check" CHECK ("project_bindings"."target_type" in ('agent', 'tool_connection', 'skill', 'document'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "category_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_edges_company_id_companies_id_fk') THEN
    ALTER TABLE "org_edges" ADD CONSTRAINT "org_edges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_bindings_company_id_companies_id_fk') THEN
    ALTER TABLE "project_bindings" ADD CONSTRAINT "project_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_bindings_project_id_projects_id_fk') THEN
    ALTER TABLE "project_bindings" ADD CONSTRAINT "project_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_categories_company_id_companies_id_fk') THEN
    ALTER TABLE "project_categories" ADD CONSTRAINT "project_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_edges_company_member_uq" ON "org_edges" USING btree ("company_id","member_type","member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_bindings_target_idx" ON "project_bindings" USING btree ("company_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_bindings_project_target_uq" ON "project_bindings" USING btree ("company_id","project_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_categories_company_idx" ON "project_categories" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_categories_company_name_uq" ON "project_categories" USING btree ("company_id","name");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_category_id_project_categories_id_fk') THEN
    ALTER TABLE "projects" ADD CONSTRAINT "projects_category_id_project_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."project_categories"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
-- Day one behind projects:access must be behaviourally identical: every
-- active user gets a null-scope grant so the new check never narrows
-- who could already reach projects.
INSERT INTO "principal_permission_grants" (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key",
  "scope",
  "granted_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  "company_id",
  'user',
  "principal_id",
  'projects:access',
  NULL,
  NULL,
  now(),
  now()
FROM "company_memberships"
WHERE "principal_type" = 'user'
  AND "status" = 'active'
ON CONFLICT (
  "company_id",
  "principal_type",
  "principal_id",
  "permission_key"
) DO NOTHING;

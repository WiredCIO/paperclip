-- WiredCIO fork migration (originally 0281_late_silk_fever on wiredcio/deploy,
-- renumbered after upstream's 0434). Converts the projects.category_id foreign
-- key to ON DELETE SET NULL. Idempotent: the drop/add pair always ends in the
-- same state, and 0435 already creates the constraint with SET NULL on a fresh
-- database.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_category_id_project_categories_id_fk' AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE "projects" DROP CONSTRAINT "projects_category_id_project_categories_id_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_category_id_project_categories_id_fk') THEN
    ALTER TABLE "projects" ADD CONSTRAINT "projects_category_id_project_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."project_categories"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

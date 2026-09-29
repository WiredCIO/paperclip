import { z } from "zod";
import { PROJECT_BINDING_TARGET_TYPES } from "../constants.js";
import { objectWithoutDefaults } from "./partial.js";

export const createProjectCategorySchema = z.object({
  name: z.string().trim().min(1).max(200),
  sortOrder: z.number().int().optional(),
});

export type CreateProjectCategory = z.infer<typeof createProjectCategorySchema>;

export const updateProjectCategorySchema = objectWithoutDefaults(createProjectCategorySchema).partial();

export type UpdateProjectCategory = z.infer<typeof updateProjectCategorySchema>;

const projectBindingEntrySchema = z.object({
  projectId: z.string().guid(),
  targetType: z.enum(PROJECT_BINDING_TARGET_TYPES),
  targetId: z.string().trim().min(1),
});

export const putProjectBindingsSchema = z.object({
  bindings: z.array(projectBindingEntrySchema).max(2000),
});

export type PutProjectBindings = z.infer<typeof putProjectBindingsSchema>;

const projectAccessScopeSchema = z
  .object({
    categoryIds: z.array(z.string().guid()).optional(),
    projectIds: z.array(z.string().guid()).optional(),
  })
  .strict();

export const putProjectAccessGrantSchema = z.object({
  scope: projectAccessScopeSchema.nullable(),
});

export type PutProjectAccessGrant = z.infer<typeof putProjectAccessGrantSchema>;

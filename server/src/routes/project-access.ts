import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createProjectCategorySchema,
  putProjectAccessGrantSchema,
  putProjectBindingsSchema,
  updateProjectCategorySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, projectAccessService } from "../services/index.js";
import { assertBoardCompanyOwnerOrAdmin, getActorInfo, hasCompanyAccess } from "./authz.js";

const CATEGORY_CAPABILITY = "project categories";
const BINDINGS_CAPABILITY = "project bindings";
const GRANT_CAPABILITY = "project access grants";

export function projectAccessRoutes(db: Db) {
  const router = Router();
  const svc = projectAccessService(db);

  router.get("/companies/:companyId/project-categories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompanyOwnerOrAdmin(req, companyId, CATEGORY_CAPABILITY);
    res.json(await svc.listCategories(companyId));
  });

  router.post(
    "/companies/:companyId/project-categories",
    validate(createProjectCategorySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoardCompanyOwnerOrAdmin(req, companyId, CATEGORY_CAPABILITY);
      const created = await svc.createCategory(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project_category.created",
        entityType: "project_category",
        entityId: created.id,
        details: { name: created.name, sortOrder: created.sortOrder },
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/project-categories/:id",
    validate(updateProjectCategorySchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getCategoryById(id);
      if (!existing || !hasCompanyAccess(req, existing.companyId)) {
        res.status(404).json({ error: "Project category not found" });
        return;
      }
      assertBoardCompanyOwnerOrAdmin(req, existing.companyId, CATEGORY_CAPABILITY);
      const updated = await svc.updateCategory(id, req.body);
      if (!updated) {
        res.status(404).json({ error: "Project category not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: updated.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project_category.updated",
        entityType: "project_category",
        entityId: updated.id,
        details: req.body,
      });
      res.json(updated);
    },
  );

  router.delete("/project-categories/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getCategoryById(id);
    if (!existing || !hasCompanyAccess(req, existing.companyId)) {
      res.status(404).json({ error: "Project category not found" });
      return;
    }
    assertBoardCompanyOwnerOrAdmin(req, existing.companyId, CATEGORY_CAPABILITY);
    const deleted = await svc.deleteCategory(id);
    if (!deleted) {
      res.status(404).json({ error: "Project category not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: deleted.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project_category.deleted",
      entityType: "project_category",
      entityId: deleted.id,
      details: { name: deleted.name },
    });
    res.json(deleted);
  });

  router.get("/companies/:companyId/project-bindings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompanyOwnerOrAdmin(req, companyId, BINDINGS_CAPABILITY);
    res.json({ bindings: await svc.listBindings(companyId) });
  });

  router.put(
    "/companies/:companyId/project-bindings",
    validate(putProjectBindingsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoardCompanyOwnerOrAdmin(req, companyId, BINDINGS_CAPABILITY);
      const actor = getActorInfo(req);
      const bindings = await svc.putBindings(companyId, req.body.bindings, actor.actorId);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project_bindings.replaced",
        entityType: "project_bindings",
        entityId: companyId,
        details: { count: bindings.length },
      });
      res.json({ bindings });
    },
  );

  router.get("/companies/:companyId/members/:userId/project-access", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    assertBoardCompanyOwnerOrAdmin(req, companyId, GRANT_CAPABILITY);
    const isMember = await svc.isActiveCompanyMember(companyId, userId);
    if (!isMember) {
      res.status(404).json({ error: "Company member not found" });
      return;
    }
    const grant = await svc.getAccessGrant(companyId, userId);
    res.json({ grant: grant ? { scope: grant.scope, updatedAt: grant.updatedAt } : null });
  });

  router.put(
    "/companies/:companyId/members/:userId/project-access",
    validate(putProjectAccessGrantSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      assertBoardCompanyOwnerOrAdmin(req, companyId, GRANT_CAPABILITY);
      const isMember = await svc.isActiveCompanyMember(companyId, userId);
      if (!isMember) {
        res.status(404).json({ error: "Company member not found" });
        return;
      }
      const grantedByUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
      const grant = await svc.putAccessGrant(companyId, userId, req.body.scope, grantedByUserId);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project_access_grant.updated",
        entityType: "project_access_grant",
        entityId: grant.id,
        details: { targetUserId: userId, scope: grant.scope },
      });
      res.json({ scope: grant.scope, updatedAt: grant.updatedAt });
    },
  );

  router.delete("/companies/:companyId/members/:userId/project-access", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    assertBoardCompanyOwnerOrAdmin(req, companyId, GRANT_CAPABILITY);
    const isMember = await svc.isActiveCompanyMember(companyId, userId);
    if (!isMember) {
      res.status(404).json({ error: "Company member not found" });
      return;
    }
    const deleted = await svc.deleteAccessGrant(companyId, userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project_access_grant.deleted",
      entityType: "project_access_grant",
      entityId: deleted?.id ?? userId,
      details: { targetUserId: userId },
    });
    res.json({ deleted: Boolean(deleted) });
  });

  return router;
}

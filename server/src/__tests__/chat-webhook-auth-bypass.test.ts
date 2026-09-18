import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { activityLog } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  restoreChatWebhookAuthorization,
  stripChatWebhookAuthorization,
} from "../app.js";

function createEmptyDb() {
  return {
    select: () => ({
      from: (_table: unknown) => ({
        where: () => Promise.resolve([]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    insert: (table: unknown) => ({
      values: (_values: Record<string, unknown>) => {
        if (table === activityLog) {
          // no-op
        }
        return Promise.resolve([]);
      },
    }),
  } as any;
}

function buildApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(stripChatWebhookAuthorization);
  app.use(
    actorMiddleware(db, {
      deploymentMode: "local_trusted",
      resolveSession: async () => null,
    }),
  );
  app.use(restoreChatWebhookAuthorization);
  app.post("/api/chat-webhooks/:publicId/:provider", (req, res) => {
    res.json({
      reachedWebhook: true,
      authorization: req.headers.authorization,
      actorType: req.actor?.type,
    });
  });
  app.get("/api/companies/:companyId", (req, res) => {
    res.json({ reachedProtectedRoute: true, actorType: req.actor?.type });
  });
  app.use(errorHandler);
  return app;
}

describe("chat webhook Authorization bypass", () => {
  it("lets a bearer-carrying Teams webhook reach the provider route with the header restored", async () => {
    const db = createEmptyDb();
    const app = buildApp(db);

    const res = await request(app)
      .post("/api/chat-webhooks/abc123/microsoft-teams")
      .set("Authorization", "Bearer teams.bot.framework.jwt")
      .set("Content-Type", "application/json")
      .send('{"type":"message"}');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      reachedWebhook: true,
      authorization: "Bearer teams.bot.framework.jwt",
      actorType: "board",
    });
  });

  it("lets a header-less webhook reach the provider route unchanged", async () => {
    const db = createEmptyDb();
    const app = buildApp(db);

    const res = await request(app)
      .post("/api/chat-webhooks/abc123/microsoft-teams")
      .set("Content-Type", "application/json")
      .send('{"type":"message"}');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      reachedWebhook: true,
      actorType: "board",
    });
    expect(res.body).not.toHaveProperty("authorization");
  });

  it("still rejects a bogus bearer on non-webhook API routes", async () => {
    const db = createEmptyDb();
    const app = buildApp(db);

    const res = await request(app)
      .get("/api/companies/any-company")
      .set("Authorization", "Bearer not-a-paperclip-token");

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent token did not verify");
  });

  it.each([
    "/api/chat-webhooks-similar-path",
    "/api/companies/any-company",
    "/api/chat-webhooks-",
  ])("does not bypass actorMiddleware for lookalike path %s", async (path) => {
    const db = createEmptyDb();
    const app = buildApp(db);

    const res = await request(app)
      .post(path)
      .set("Authorization", "Bearer any-token")
      .send("{}");

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent token did not verify");
  });
});

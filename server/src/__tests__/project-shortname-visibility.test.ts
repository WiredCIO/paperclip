import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  projectCategories,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { projectRoutes } from "../routes/projects.js";

/**
 * WIR-1382: under `enforce`, a Sales-only operator's shortname lookup only
 * considers projects they can see, so a hidden Delivery namesake neither 409s
 * the request nor reveals that it exists. Owner, shadow and off still 409.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("project shortname resolution honours project visibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-shortname-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(projectCategories);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function actorFor(companyId: string, userId: string, membershipRole: string): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole }],
    } as Express.Request["actor"];
  }

  function app(actor: Express.Request["actor"], routeDb: Db = db) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", projectRoutes(routeDb));
    instance.use(errorHandler);
    return instance;
  }

  /** Records the table of every `db.select(...).from(table)` the routes run. */
  function tableRecordingDb() {
    const tables: unknown[] = [];
    const recording = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return (...args: unknown[]) => {
            const builder = (target.select as (...a: unknown[]) => { from: (...a: unknown[]) => unknown })(...args);
            const from = builder.from.bind(builder);
            builder.from = (table: unknown, ...rest: unknown[]) => {
              tables.push(table);
              return from(table, ...rest);
            };
            return builder;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { db: recording, tables };
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Project shortname visibility ${randomUUID()}`,
      issuePrefix: `S${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [sales] = await db.insert(projectCategories).values({ companyId, name: "Sales" }).returning();
    const [delivery] = await db.insert(projectCategories).values({ companyId, name: "Delivery" }).returning();
    const [salesAcme] = await db.insert(projects).values({ companyId, name: "Acme", categoryId: sales!.id }).returning();
    const [deliveryAcme] = await db.insert(projects).values({ companyId, name: "Acme", categoryId: delivery!.id }).returning();

    const ownerId = `user-${randomUUID()}`;
    const salesOperatorId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: salesOperatorId, status: "active", membershipRole: "operator" },
    ]);
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: salesOperatorId,
      permissionKey: "projects:access",
      scope: { categoryIds: [sales!.id] },
      grantedByUserId: null,
    });

    return {
      companyId,
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      salesAcme: salesAcme!,
      deliveryAcme: deliveryAcme!,
    };
  }

  it("resolves a shortname to the visible project when a hidden namesake exists", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    const res = await request(app(fixture.salesOperator)).get(`/api/projects/acme?companyId=${fixture.companyId}`);

    expect(res.status, res.text).toBe(200);
    expect(res.body.id).toBe(fixture.salesAcme.id);
  });

  it("still 409s an ambiguous shortname for an owner under enforce", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();

    const res = await request(app(fixture.owner)).get(`/api/projects/acme?companyId=${fixture.companyId}`);

    expect(res.status, res.text).toBe(409);
  });

  it.each(["shadow", "off"])("still 409s an ambiguous shortname for a restricted operator in %s mode", async (mode) => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", mode);
    const fixture = await seed();

    const res = await request(app(fixture.salesOperator)).get(`/api/projects/acme?companyId=${fixture.companyId}`);

    expect(res.status, res.text).toBe(409);
  });

  it("makes no visibility query in off mode", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
    const fixture = await seed();
    const recorder = tableRecordingDb();

    // The 409 is thrown by the param handler, so every query recorded here
    // comes from shortname resolution.
    const res = await request(app(fixture.salesOperator, recorder.db))
      .get(`/api/projects/acme?companyId=${fixture.companyId}`);

    expect(res.status, res.text).toBe(409);
    expect(recorder.tables).toEqual([projects]);
  });

  it("reads the actor's grant in enforce mode (the recorder sees visibility queries)", async () => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
    const fixture = await seed();
    const recorder = tableRecordingDb();

    await request(app(fixture.salesOperator, recorder.db)).get(`/api/projects/acme?companyId=${fixture.companyId}`);

    expect(recorder.tables).toContain(principalPermissionGrants);
  });
});

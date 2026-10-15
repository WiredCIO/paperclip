import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage/types.js";

/**
 * WIR-124 (T6): a project-visibility denial must not confirm that the
 * resource exists. For a Sales-only operator, each bespoke issue route that
 * reaches a Delivery issue must answer with the same status and the same
 * bytes as a request for an id that does not exist. Owners are unchanged.
 */

const COMPANY_ID = "company-1";
const DELIVERY_PROJECT_ID = "77777777-7777-4777-8777-777777777777";
const DELIVERY_AGENT_ID = "agent-delivery";
const HIDDEN_ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const HIDDEN_ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";
const HIDDEN_WORK_PRODUCT_ID = "44444444-4444-4444-8444-444444444444";
const RANDOM_ID = "99999999-9999-4999-8999-999999999999";
const VISIBLE_ISSUE_ID = "66666666-6666-4666-8666-666666666666";

const hiddenIssue = {
  id: HIDDEN_ISSUE_ID,
  companyId: COMPANY_ID,
  projectId: DELIVERY_PROJECT_ID,
  parentId: null,
  status: "todo",
  assigneeAgentId: null,
  assigneeUserId: null,
  identifier: "PAP-1",
  conversationAgentId: null,
  conversationUserId: null,
};

const hiddenAttachment = {
  id: HIDDEN_ATTACHMENT_ID,
  companyId: COMPANY_ID,
  issueId: HIDDEN_ISSUE_ID,
  issueCommentId: null,
  assetId: "asset-1",
  provider: "local_disk",
  objectKey: "issues/issue-1/notes.txt",
  contentType: "text/plain",
  byteSize: 4,
  sha256: "sha256-sample",
  originalFilename: "notes.txt",
  createdByAgentId: null,
  createdByUserId: "user-owner",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const hiddenWorkProduct = {
  id: HIDDEN_WORK_PRODUCT_ID,
  companyId: COMPANY_ID,
  issueId: HIDDEN_ISSUE_ID,
  type: "pull_request",
  provider: "github",
  title: "PR",
  metadata: null,
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getAttachmentById: vi.fn(),
  listAttachments: vi.fn(),
  removeAttachment: vi.fn(),
  createAttachment: vi.fn(),
  getConversation: vi.fn(),
  create: vi.fn(),
}));
const mockWorkProductService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  createForIssue: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const candidateIssueRows = vi.hoisted(() => ({ rows: [] as unknown[] }));

function instanceSettingsStub() {
  return {
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" })),
    getExperimental: vi.fn(async () => ({ enableAgentChat: true, enableExternalObjects: true })),
    listCompanyIds: vi.fn(async () => [COMPANY_ID]),
  };
}

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectService,
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: instanceSettingsStub,
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => ({}),
    companyService: () => ({ getById: vi.fn(async () => ({ id: COMPANY_ID })) }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: instanceSettingsStub,
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

function createStorage(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(async (input) => ({
      provider: "local_disk",
      objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "sha256-sample",
      originalFilename: input.originalFilename,
    })),
    getObject: vi.fn(async () => ({
      stream: Readable.from(Buffer.from("test")),
      contentLength: 4,
    })),
    headObject: vi.fn(),
    deleteObject: vi.fn(async () => undefined),
  } as unknown as StorageService;
}

type Role = "operator" | "owner";

function boardActor(role: Role) {
  return {
    type: "board",
    userId: role === "owner" ? "user-owner" : "user-sales",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [COMPANY_ID],
    memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: role }],
  };
}

// The candidate-issue query in the bulk summaries route is the only direct db
// read these routes make; it returns whatever the test put in candidateIssueRows.
const fakeDb = {
  select: () => ({
    from: () => ({
      where: async () => candidateIssueRows.rows,
    }),
  }),
};

async function createApp(role: Role) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = boardActor(role);
    next();
  });
  app.use("/api", issueRoutes(fakeDb as any, createStorage()));
  app.use(errorHandler);
  return app;
}

type Probe = (app: express.Express, id: string) => request.Test;

async function expectIndistinguishable(app: express.Express, probe: Probe, hiddenId: string) {
  const hidden = await probe(app, hiddenId);
  const random = await probe(app, RANDOM_ID);
  expect(random.status).toBe(404);
  expect(hidden.status).toBe(random.status);
  expect(hidden.text).toBe(random.text);
  return hidden;
}

describe("project visibility renders read denials as 404 (WIR-124)", { timeout: 60_000 }, () => {
  const previousMode = process.env.PAPERCLIP_PROJECT_ACCESS_MODE;

  beforeEach(() => {
    process.env.PAPERCLIP_PROJECT_ACCESS_MODE = "enforce";
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();

    mockAccessService.decide.mockImplementation(async (input: any) => {
      const restricted = input.actor?.userId === "user-sales";
      const hidden =
        (input.resource.type === "issue" && input.resource.projectId === DELIVERY_PROJECT_ID) ||
        (input.resource.type === "project" && input.resource.projectId === DELIVERY_PROJECT_ID) ||
        (input.resource.type === "agent" && input.resource.agentId === DELIVERY_AGENT_ID);
      if (restricted && hidden) {
        return {
          allowed: false,
          action: input.action,
          reason: "deny_project_visibility",
          explanation: "hidden",
        };
      }
      return { allowed: true, action: input.action, reason: "allow_simple_company_member", explanation: "ok" };
    });
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === HIDDEN_ISSUE_ID) return hiddenIssue;
      if (id === VISIBLE_ISSUE_ID) return { ...hiddenIssue, id, projectId: null };
      if (id === OTHER_COMPANY_ISSUE_ID) return { ...hiddenIssue, id, companyId: "company-2", projectId: null };
      return null;
    });
    mockIssueService.getAttachmentById.mockImplementation(async (id: string) =>
      id === HIDDEN_ATTACHMENT_ID ? hiddenAttachment : null,
    );
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.removeAttachment.mockResolvedValue(hiddenAttachment);
    mockIssueService.getConversation.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue({ ...hiddenIssue, projectId: null, conversationAgentId: DELIVERY_AGENT_ID });
    mockIssueService.createAttachment.mockResolvedValue({ ...hiddenAttachment, artifactWorkProductId: null });
    mockWorkProductService.getById.mockImplementation(async (id: string) =>
      id === HIDDEN_WORK_PRODUCT_ID ? hiddenWorkProduct : null,
    );
    mockWorkProductService.update.mockResolvedValue(hiddenWorkProduct);
    mockWorkProductService.remove.mockResolvedValue(hiddenWorkProduct);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, ref: string) =>
      ref === DELIVERY_AGENT_ID
        ? { ambiguous: false, agent: { id: DELIVERY_AGENT_ID, name: "Delivery agent" } }
        : { ambiguous: false, agent: null },
    );
    mockExternalObjectService.getIssueSummaries.mockImplementation(
      async (_companyId: string, ids: string[]) => new Map(ids.map((id) => [id, { total: 1 }])),
    );
    candidateIssueRows.rows = [];
  });

  afterEach(() => {
    if (previousMode === undefined) delete process.env.PAPERCLIP_PROJECT_ACCESS_MODE;
    else process.env.PAPERCLIP_PROJECT_ACCESS_MODE = previousMode;
  });

  const probes: Array<{ name: string; hiddenId: string; probe: Probe; ownerStatus: number }> = [
    {
      name: "GET /issues/:id/attachments (common read helper)",
      hiddenId: HIDDEN_ISSUE_ID,
      probe: (app, id) => request(app).get(`/api/issues/${id}/attachments`),
      ownerStatus: 200,
    },
    {
      name: "GET /attachments/:id/content",
      hiddenId: HIDDEN_ATTACHMENT_ID,
      probe: (app, id) => request(app).get(`/api/attachments/${id}/content`),
      ownerStatus: 200,
    },
    {
      name: "DELETE /attachments/:id",
      hiddenId: HIDDEN_ATTACHMENT_ID,
      probe: (app, id) => request(app).delete(`/api/attachments/${id}`),
      ownerStatus: 200,
    },
    {
      name: "PATCH /work-products/:id",
      hiddenId: HIDDEN_WORK_PRODUCT_ID,
      probe: (app, id) => request(app).patch(`/api/work-products/${id}`).send({ title: "Renamed" }),
      ownerStatus: 200,
    },
    {
      name: "DELETE /work-products/:id",
      hiddenId: HIDDEN_WORK_PRODUCT_ID,
      probe: (app, id) => request(app).delete(`/api/work-products/${id}`),
      ownerStatus: 200,
    },
    {
      name: "POST /companies/:companyId/issues/:issueId/attachments",
      hiddenId: HIDDEN_ISSUE_ID,
      probe: (app, id) =>
        request(app)
          .post(`/api/companies/${COMPANY_ID}/issues/${id}/attachments`)
          .attach("file", Buffer.from("test"), { filename: "notes.txt", contentType: "text/plain" }),
      ownerStatus: 201,
    },
    {
      name: "GET /companies/:companyId/chats/:agentRef",
      hiddenId: DELIVERY_AGENT_ID,
      probe: (app, id) => request(app).get(`/api/companies/${COMPANY_ID}/chats/${id}`),
      ownerStatus: 200,
    },
    {
      name: "POST /companies/:companyId/chats/:agentRef",
      hiddenId: DELIVERY_AGENT_ID,
      probe: (app, id) => request(app).post(`/api/companies/${COMPANY_ID}/chats/${id}`),
      ownerStatus: 200,
    },
  ];

  for (const { name, hiddenId, probe } of probes) {
    it(`${name}: Sales-only operator gets the random-id 404 byte for byte`, async () => {
      const app = await createApp("operator");
      await expectIndistinguishable(app, probe, hiddenId);
    });
  }

  for (const { name, hiddenId, probe, ownerStatus } of probes) {
    it(`${name}: owner still reaches the resource`, async () => {
      const app = await createApp("owner");
      const res = await probe(app, hiddenId);
      expect(res.status).toBe(ownerStatus);
    });
  }

  // WIR-971: the core board write routes load the issue through the same
  // visibility-aware helper, so a hidden issue cannot be mutated, commented
  // on or deleted by id.
  const writeProbes: Array<{ name: string; probe: Probe }> = [
    {
      name: "PATCH /issues/:id",
      probe: (app, id) => request(app).patch(`/api/issues/${id}`).send({ title: "Renamed" }),
    },
    {
      name: "POST /issues/:id/comments",
      probe: (app, id) => request(app).post(`/api/issues/${id}/comments`).send({ body: "hello" }),
    },
    {
      name: "DELETE /issues/:id",
      probe: (app, id) => request(app).delete(`/api/issues/${id}`),
    },
  ];

  for (const { name, probe } of writeProbes) {
    it(`${name}: Sales-only operator gets the random-id 404 byte for byte`, async () => {
      const app = await createApp("operator");
      await expectIndistinguishable(app, probe, HIDDEN_ISSUE_ID);
    });

    it(`${name}: owner is not stopped by the visibility gate`, async () => {
      const app = await createApp("owner");
      const res = await probe(app, HIDDEN_ISSUE_ID);
      expect(res.status).not.toBe(404);
    });
  }

  it("attachment upload answers a cross-company issue with the random-id 404, not 422", async () => {
    const app = await createApp("owner");
    const probe: Probe = (target, id) =>
      request(target)
        .post(`/api/companies/${COMPANY_ID}/issues/${id}/attachments`)
        .attach("file", Buffer.from("test"), { filename: "notes.txt", contentType: "text/plain" });
    await expectIndistinguishable(app, probe, OTHER_COMPANY_ISSUE_ID);
  });

  it("bulk external-object summaries drop a hidden id exactly like an unknown id", async () => {
    const app = await createApp("operator");
    candidateIssueRows.rows = [hiddenIssue];
    const hidden = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues/external-object-summaries`)
      .send({ issueIds: [HIDDEN_ISSUE_ID] });
    candidateIssueRows.rows = [];
    const random = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues/external-object-summaries`)
      .send({ issueIds: [RANDOM_ID] });
    expect(hidden.status).toBe(200);
    expect(hidden.status).toBe(random.status);
    expect(hidden.text).toBe(random.text);

    const ownerApp = await createApp("owner");
    candidateIssueRows.rows = [hiddenIssue];
    const owner = await request(ownerApp)
      .post(`/api/companies/${COMPANY_ID}/issues/external-object-summaries`)
      .send({ issueIds: [HIDDEN_ISSUE_ID] });
    expect(owner.body.summaries).toHaveProperty(HIDDEN_ISSUE_ID);
  });

  // WIR-1187 (T5c): every board-reachable issue write route answers a hidden
  // issue exactly like an id that does not exist.
  const ID = "55555555-5555-4555-8555-555555555555";
  const queue = { queueId: "queue-1", revision: "rev-1" };
  const subRouteWriteProbes: Array<{ name: string; probe: Probe }> = [
    ["POST", "runner-goal/actions", { requestId: "r-1", agentId: ID, expectedRevision: 0, action: "pause" }],
    ["PUT", "watchdog", { agentId: ID }],
    ["DELETE", "watchdog"],
    ["POST", "recovery-actions/resolve", { outcome: "restored", sourceIssueStatus: "todo" }],
    ["POST", "external-objects/refresh", {}],
    ["POST", "documents/plan/annotations", {
      baseRevisionId: ID,
      baseRevisionNumber: 1,
      selector: {
        quote: { exact: "x" },
        position: { normalizedStart: 0, normalizedEnd: 1, markdownStart: 0, markdownEnd: 1 },
      },
      body: "note",
    }],
    ["POST", `documents/plan/annotations/${ID}/comments`, { body: "note" }],
    ["PATCH", `documents/plan/annotations/${ID}`, { status: "resolved" }],
    ["PUT", "documents/plan", { format: "markdown", body: "x" }],
    ["POST", "documents/plan/lock"],
    ["POST", "documents/plan/unlock"],
    ["POST", `documents/plan/revisions/${ID}/restore`, {}],
    ["DELETE", "documents/plan"],
    ["POST", "work-products", { type: "pull_request", provider: "github", title: "PR" }],
    ["POST", `work-products/${ID}/review-document`],
    ["POST", "low-trust/promotions", { sourceArtifactKind: "issue", sourceArtifactId: ID, title: "t", summary: "s" }],
    ["POST", "read"],
    ["DELETE", "read"],
    ["POST", "inbox-archive", {}],
    ["DELETE", "inbox-archive", {}],
    ["POST", "approvals", { approvalId: ID }],
    ["DELETE", `approvals/${ID}`],
    ["POST", "children", { title: "Child" }],
    ["POST", "accepted-plan-decompositions", { acceptedPlanRevisionId: ID, children: [{ title: "Child" }] }],
    ["POST", "monitor/check-now"],
    ["POST", "scheduled-retry/retry-now"],
    ["POST", "stalled-review-decision", { action: "approve" }],
    ["POST", "checkout", { agentId: ID, expectedStatuses: ["todo"] }],
    ["POST", "release"],
    ["POST", "admin/force-release"],
    ["PATCH", `queued-comments/${ID}`, { ...queue, body: "edited" }],
    ["PUT", "queued-comments/order", { ...queue, orderedCommentIds: [] }],
    ["POST", "queued-comments/interrupt", { ...queue, targetRunId: null }],
    ["POST", `queued-comments/${ID}/steer`, { ...queue, targetRunId: "run-1" }],
    ["DELETE", `queued-comments/${ID}`, queue],
    ["POST", "interactions", { kind: "request_confirmation", payload: { version: 1, prompt: "Proceed?" } }],
    ["POST", `interactions/${ID}/accept`, {}],
    ["POST", `interactions/${ID}/reject`, {}],
    ["POST", `interactions/${ID}/respond`, { answers: [] }],
    ["POST", `interactions/${ID}/verdicts`, { verdicts: [{ id: "item-1", verdict: "approve" }] }],
    ["POST", `interactions/${ID}/withdraw`, {}],
    ["POST", `interactions/${ID}/skip`, {}],
    ["POST", `interactions/${ID}/cancel`, {}],
    ["DELETE", `comments/${ID}`],
    ["POST", "feedback-votes", { targetType: "issue_comment", targetId: ID, vote: "up" }],
  ].map(([method, path, body]) => ({
    name: `${method} /issues/:id/${String(path).replaceAll(ID, ":x")}`,
    probe: (app, id) => {
      const url = `/api/issues/${id}/${path}`;
      const req = method === "POST" ? request(app).post(url)
        : method === "PUT" ? request(app).put(url)
        : method === "PATCH" ? request(app).patch(url)
        : request(app).delete(url);
      return body === undefined ? req : req.send(body as object);
    },
  }));

  for (const { name, probe } of subRouteWriteProbes) {
    it(`${name}: Sales-only operator gets the random-id 404 byte for byte`, async () => {
      const app = await createApp("operator");
      await expectIndistinguishable(app, probe, HIDDEN_ISSUE_ID);
    });
  }

  for (const { name, probe } of subRouteWriteProbes) {
    it(`${name}: owner is not turned away by project visibility`, async () => {
      const app = await createApp("owner");
      const hidden = await probe(app, HIDDEN_ISSUE_ID);
      const random = await probe(app, RANDOM_ID);
      expect(hidden.text).not.toBe(random.text);
    });
  }

  describe("placing an issue in a hidden project (WIR-1187)", () => {
    const moves: Array<{ name: string; probe: (app: express.Express) => request.Test; error: string }> = [
      {
        name: "POST /companies/:companyId/issues into a hidden project",
        probe: (app) => request(app).post(`/api/companies/${COMPANY_ID}/issues`)
          .send({ title: "New", projectId: DELIVERY_PROJECT_ID }),
        error: "Project not found",
      },
      {
        name: "POST /companies/:companyId/issues under a hidden parent",
        probe: (app) => request(app).post(`/api/companies/${COMPANY_ID}/issues`)
          .send({ title: "New", parentId: HIDDEN_ISSUE_ID }),
        error: "Parent issue not found",
      },
      {
        name: "POST /issues/:id/children into a hidden project",
        probe: (app) => request(app).post(`/api/issues/${VISIBLE_ISSUE_ID}/children`)
          .send({ title: "Child", projectId: DELIVERY_PROJECT_ID }),
        error: "Project not found",
      },
      {
        name: "PATCH /issues/:id projectId into a hidden project",
        probe: (app) => request(app).patch(`/api/issues/${VISIBLE_ISSUE_ID}`)
          .send({ projectId: DELIVERY_PROJECT_ID }),
        error: "Project not found",
      },
      {
        name: "PATCH /issues/:id parentId under a hidden parent",
        probe: (app) => request(app).patch(`/api/issues/${VISIBLE_ISSUE_ID}`)
          .send({ parentId: HIDDEN_ISSUE_ID }),
        error: "Parent issue not found",
      },
    ];

    for (const { name, probe, error } of moves) {
      it(`${name}: Sales-only operator gets 404`, async () => {
        const res = await probe(await createApp("operator"));
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error });
      });

      it(`${name}: owner is not refused for visibility`, async () => {
        const res = await probe(await createApp("owner"));
        expect(res.body?.error).not.toBe(error);
      });
    }
  });

  it("write routes make no visibility decisions when the mode is off", async () => {
    process.env.PAPERCLIP_PROJECT_ACCESS_MODE = "off";
    const app = await createApp("operator");
    await request(app).post(`/api/issues/${HIDDEN_ISSUE_ID}/documents/plan/lock`);
    await request(app).post(`/api/issues/${VISIBLE_ISSUE_ID}/children`).send({ title: "Child", projectId: DELIVERY_PROJECT_ID });
    expect(mockAccessService.decide).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "issue:read" }),
    );
    expect(mockAccessService.decide).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "project:read" }),
    );
  });

  it("makes no visibility decisions when the mode is off", async () => {
    process.env.PAPERCLIP_PROJECT_ACCESS_MODE = "off";
    const app = await createApp("operator");
    await request(app).delete(`/api/work-products/${HIDDEN_WORK_PRODUCT_ID}`);
    expect(mockAccessService.decide).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "@paperclipai/mcp-server";
import { createWiredcioMcpServer } from "./index.js";
import { createWiredcioToolDefinitions } from "./tools.js";

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  });
}

function getTool(name: string) {
  const tool = createWiredcioToolDefinitions(makeClient()).find((c) => c.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("wiredcio MCP tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("composes upstream's tools with the local ones, without duplicates", () => {
    const { tools } = createWiredcioMcpServer({
      apiUrl: "http://localhost:3100/api",
      apiKey: "token-123",
      companyId: null,
      agentId: null,
      runId: null,
    });
    const names = tools.map((t) => t.name);
    // Upstream is present…
    expect(names).toContain("paperclipCreateIssue");
    // …and so are ours.
    expect(names).toContain("paperclipListRoutines");
    expect(names).toContain("paperclipUpdateWorkProduct");
    // Composition must not shadow: a duplicate would resolve by array order.
    expect(new Set(names).size).toBe(names.length);
    expect(tools.length).toBeGreaterThan(createWiredcioToolDefinitions(makeClient()).length);
  });

  it("lists routines under the default company id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipListRoutines").execute({});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/routines",
    );
    expect(init.method).toBe("GET");
  });

  it("creates a routine without inventing a schedule", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "r1" }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipCreateRoutine").execute({
      title: "Nightly backlog sweep",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.title).toBe("Nightly backlog sweep");
    // A routine carries no trigger of its own; the schedule is a separate call.
    expect(body).not.toHaveProperty("triggers");
  });

  it("sends a trigger create to the routine's own triggers endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "t1" }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipCreateRoutineTrigger").execute({
      routineId: "44444444-4444-4444-4444-444444444444",
      trigger: {
        kind: "schedule",
        cronExpression: "0 7 * * 1-5",
        timezone: "America/Chicago",
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/routines/44444444-4444-4444-4444-444444444444/triggers",
    );
    // The nested union is unwrapped — the server receives the trigger itself,
    // not a { trigger: … } envelope.
    expect(JSON.parse(String(init.body))).toMatchObject({
      kind: "schedule",
      cronExpression: "0 7 * * 1-5",
    });
  });

  it("reschedules through /routine-triggers, not the routine", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipUpdateRoutineTrigger").execute({
      triggerId: "55555555-5555-5555-5555-555555555555",
      cronExpression: "0 9 * * 1-5",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The whole point of the tool: PATCH /routines/:id would accept a cron
    // change, ignore it, and still return 200.
    expect(String(url)).toBe(
      "http://localhost:3100/api/routine-triggers/55555555-5555-5555-5555-555555555555",
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ cronExpression: "0 9 * * 1-5" });
  });

  it("warns about the trigger trap in the tool description an agent reads", () => {
    const description = getTool("paperclipUpdateRoutine").description;
    expect(description.toLowerCase()).toContain("trigger");
    expect(description).toContain("paperclipUpdateRoutineTrigger");
  });

  it("lists the work products an issue produced", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipListIssueWorkProducts").execute({ issueId: "PAP-1200" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1200/work-products");
    expect(init.method).toBe("GET");
  });

  it("records a review decision on a work product", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("paperclipUpdateWorkProduct").execute({
      workProductId: "66666666-6666-6666-6666-666666666666",
      reviewState: "changes_requested",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/work-products/66666666-6666-6666-6666-666666666666",
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ reviewState: "changes_requested" });
  });

  it("rejects a review state the API does not define", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const response = await getTool("paperclipUpdateWorkProduct").execute({
      workProductId: "66666666-6666-6666-6666-666666666666",
      reviewState: "looks_fine_to_me",
    });

    expect(response.content[0]?.text.toLowerCase()).toContain("invalid");
  });
});

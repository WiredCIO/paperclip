import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
  HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  isPaperclipMcpBridgePath,
  sanitizeSandboxCallbackBridgeHeaders,
} from "./sandbox-callback-bridge.js";

describe("isPaperclipMcpBridgePath", () => {
  it("matches Paperclip's own MCP endpoints", () => {
    expect(isPaperclipMcpBridgePath("/mcp/runtime-tools")).toBe(true);
    expect(isPaperclipMcpBridgePath("/mcp/gateways/gw_abc123")).toBe(true);
    expect(isPaperclipMcpBridgePath("/api/mcp/project-tools")).toBe(true);
  });

  it("does not match the regular API, so those keep the host token", () => {
    expect(isPaperclipMcpBridgePath("/api/agents/me")).toBe(false);
    expect(isPaperclipMcpBridgePath("/api/openapi.json")).toBe(false);
    expect(isPaperclipMcpBridgePath("/runtime-tools/connections/search")).toBe(false);
  });

  it("does not match a nested path under a gateway id", () => {
    // A single segment only: a deeper path is a different route and must not
    // inherit the Authorization carve-out.
    expect(isPaperclipMcpBridgePath("/mcp/gateways/gw_abc/extra")).toBe(false);
  });

  it("does not match a lookalike prefix", () => {
    expect(isPaperclipMcpBridgePath("/mcp/runtime-tools-evil")).toBe(false);
    expect(isPaperclipMcpBridgePath("/evil/mcp/runtime-tools")).toBe(false);
  });
});

describe("route allowlist", () => {
  it("admits the MCP routes on both transports", () => {
    for (const routes of [
      DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
      HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
    ]) {
      expect(
        authorizeSandboxCallbackBridgeRequestWithRoutes(
          { method: "POST", path: "/mcp/gateways/gw_abc123" },
          routes,
        ),
      ).toBeNull();
      expect(
        authorizeSandboxCallbackBridgeRequestWithRoutes(
          { method: "POST", path: "/mcp/runtime-tools" },
          routes,
        ),
      ).toBeNull();
    }
  });

  it("still denies a method the MCP routes do not declare", () => {
    expect(
      authorizeSandboxCallbackBridgeRequestWithRoutes(
        { method: "DELETE", path: "/mcp/gateways/gw_abc123" },
        DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
      ),
    ).toMatch(/Route not allowed/);
  });

  it("still denies routes outside the allowlist", () => {
    expect(
      authorizeSandboxCallbackBridgeRequestWithRoutes(
        { method: "POST", path: "/api/companies/c1/agents" },
        DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
      ),
    ).toMatch(/Route not allowed/);
  });
});

describe("header sanitization", () => {
  const headers = {
    authorization: "Bearer pcgw_run_scoped_token",
    accept: "application/json",
    "x-evil": "nope",
  };

  it("keeps Authorization for an MCP path so the gateway sees the run's bearer", () => {
    const sanitized = sanitizeSandboxCallbackBridgeHeaders(
      headers,
      DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
      { path: "/mcp/gateways/gw_abc123" },
    );
    expect(sanitized.authorization).toBe("Bearer pcgw_run_scoped_token");
    expect(sanitized.accept).toBe("application/json");
    expect(sanitized["x-evil"]).toBeUndefined();
  });

  it("strips Authorization everywhere else, so a sandbox cannot present its own bearer", () => {
    const sanitized = sanitizeSandboxCallbackBridgeHeaders(
      headers,
      DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
      { path: "/api/agents/me" },
    );
    expect(sanitized.authorization).toBeUndefined();
    expect(sanitized.accept).toBe("application/json");
  });

  it("strips Authorization when no path is supplied, preserving the old default", () => {
    const sanitized = sanitizeSandboxCallbackBridgeHeaders(
      headers,
      DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
    );
    expect(sanitized.authorization).toBeUndefined();
  });

  it("matches the Authorization header case-insensitively", () => {
    const sanitized = sanitizeSandboxCallbackBridgeHeaders(
      { Authorization: "Bearer pcgw_x" },
      DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
      { path: "/mcp/runtime-tools" },
    );
    expect(sanitized.Authorization).toBe("Bearer pcgw_x");
  });
});

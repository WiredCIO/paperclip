import type { ToolConnectionHealthStatus } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../../../errors.js";
import { redactSensitiveText } from "../../../redaction.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

/**
 * Did this error come from the OAuth endpoint gate (PAP-17099)? Such a refusal
 * is Paperclip's own decision about an unsafe address, so it must keep its code
 * and its 422 instead of being folded into a generic upstream failure.
 */
export function isOAuthEndpointRejection(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  const code = asRecord(error.details).code;
  return typeof code === "string" && code.endsWith("_endpoint_rejected");
}

export function healthFailureHttpStatus(failure: {
  status: ToolConnectionHealthStatus;
  code: string;
}): number {
  if (failure.status === "missing_secret") return 422;
  if (failure.code === "oauth_challenge") return 422;
  if (failure.code === "oauth_refresh_missing") return 422;
  if (failure.code === "oauth_reauthorization_required") return 422;
  if (failure.code === "oauth_insufficient_scope") return 422;
  if (failure.code === "slack_mcp_access_disabled") return 422;
  if (failure.code === "user_authorization_required") return 422;
  if (failure.code === "composio_broker_retired") return 422;
  if (failure.code === "tool_connection_transport_unsupported") return 422;
  if (failure.code === "cognee_access_unverified" || failure.code === "memory_api_key_rejected") return 422;
  if (failure.code.endsWith("_endpoint_rejected")) return 422;
  return 502;
}

export function unsupportedToolConnectionTransport() {
  return unprocessable(
    "This connection has no supported tool integration. Add a supported account or MCP connection from Connectors.",
    { code: "tool_connection_transport_unsupported" },
  );
}

export function sanitizeHttpFailure(error: unknown): {
  status: ToolConnectionHealthStatus;
  message: string;
  code: string;
  /**
   * CH-4: the provider's own response body (or, for a binding_missing failure,
   * the config paths it was missing), scrubbed and truncated. `message` alone
   * used to collapse every remote failure to `HTTP 400` with no way to tell
   * what the provider actually objected to.
   */
  detail?: string;
} {
  const classified = classifyHttpFailure(error);
  if (!(error instanceof HttpError)) return classified;
  const detailsRecord = asRecord(error.details);
  const rawDetail =
    typeof detailsRecord.detail === "string"
      ? detailsRecord.detail
      : Array.isArray(detailsRecord.configPaths) &&
          detailsRecord.configPaths.every((path) => typeof path === "string")
        ? `Missing secret binding for: ${detailsRecord.configPaths.join(", ")}`
        : undefined;
  const detail = rawDetail ? redactSensitiveText(rawDetail).slice(0, 512) : undefined;
  return detail ? { ...classified, detail } : classified;
}

/** CH-4: fold the scrubbed provider detail into the text health_message/last_error store. */
export function healthMessageWithDetail(failure: { message: string; detail?: string }): string {
  return failure.detail ? `${failure.message} (${failure.detail})` : failure.message;
}

function classifyHttpFailure(error: unknown): {
  status: ToolConnectionHealthStatus;
  message: string;
  code: string;
} {
  if (error instanceof HttpError) {
    const code = asRecord(error.details).code;
    if (code === "cognee_access_unverified" || code === "memory_api_key_rejected") {
      return { status: "error", message: error.message, code };
    }
    if (code === "grant_credential_invalid" || code === "oauth_insufficient_scope") {
      return { status: code === "grant_credential_invalid" ? "missing_secret" : "degraded", message: error.message, code };
    }
    if (code === "slack_mcp_access_disabled" || code === "google_workspace_services_unavailable") {
      return { status: "error", message: error.message, code };
    }
    if (code === "user_authorization_required") {
      return { status: "error", message: error.message, code };
    }
    if (code === "tool_connection_transport_unsupported") {
      return { status: "error", message: error.message, code };
    }
    if (code === "composio_broker_retired") {
      return { status: "error", message: error.message, code };
    }
    if (typeof code === "string" && code.startsWith("remote_http_")) {
      return { status: "error", message: error.message, code };
    }
    if (isOAuthEndpointRejection(error)) {
      return { status: "error", message: error.message, code: String(code) };
    }
    if (code === "oauth_challenge") {
      return {
        status: "error",
        message: "This app needs you to sign in.",
        code: "oauth_challenge",
      };
    }
    if (code === "oauth_refresh_missing") {
      return {
        status: "failed",
        message: "OAuth credentials have expired and need to be reconnected.",
        code: "oauth_refresh_missing",
      };
    }
    if (code === "oauth_reauthorization_required") {
      return {
        status: "error",
        message: "OAuth authorization expired. Reconnect this app to continue.",
        code: "oauth_reauthorization_required",
      };
    }
    if (typeof code === "string" && code.startsWith("vercel_connect_")) {
      return {
        status:
          code === "vercel_connect_unavailable" ||
          code === "vercel_connect_auth_failed" ||
          code === "vercel_connect_installation_required"
            ? "degraded"
            : "error",
        message: error.message,
        code,
      };
    }
    if (
      code === "oauth_refresh_in_progress" ||
      code === "oauth_refresh_superseded" ||
      code === "oauth_refresh_outcome_unknown"
    ) {
      return {
        status: "error",
        message: error.message,
        code,
      };
    }
    if (
      code === "binding_missing" ||
      code === "secret_deleted" ||
      code === "secret_inactive" ||
      code === "version_missing"
    ) {
      return {
        status: "missing_secret",
        message: "A configured credential secret could not be resolved.",
        code: String(code),
      };
    }
    if (error.status === 404 && /secret/i.test(error.message)) {
      return {
        status: "missing_secret",
        message: "A configured credential secret could not be resolved.",
        code: "secret_missing",
      };
    }
    return { status: "error", message: error.message, code: "paperclip_error" };
  }
  if (error instanceof Error) {
    return {
      status: "error",
      message: error.message.slice(0, 240),
      code: "runtime_error",
    };
  }
  return {
    status: "error",
    message: "Connection check failed.",
    code: "runtime_error",
  };
}

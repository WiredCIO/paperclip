import { describe, expect, it } from "vitest";
import {
  defaultReachabilityMode,
  isHttpsOrigin,
  normalizePaperclipOrigin,
  readPaperclipReachability,
  resolvePaperclipOrigin,
} from "../services/paperclip-reachability.js";

const LOOPBACK = "http://127.0.0.1:3100";
const PUBLIC = "https://bullpen.wiredcio.com";

describe("normalizePaperclipOrigin", () => {
  it("strips a trailing slash and an /api suffix", () => {
    expect(normalizePaperclipOrigin("https://x.example/api")).toBe("https://x.example");
    expect(normalizePaperclipOrigin("https://x.example/")).toBe("https://x.example");
    expect(normalizePaperclipOrigin("https://x.example/api/")).toBe("https://x.example");
  });

  it("treats blank and non-string input as absent", () => {
    expect(normalizePaperclipOrigin("   ")).toBeNull();
    expect(normalizePaperclipOrigin(null)).toBeNull();
    expect(normalizePaperclipOrigin(undefined)).toBeNull();
  });
});

describe("isHttpsOrigin", () => {
  it("accepts https and rejects everything else", () => {
    expect(isHttpsOrigin(PUBLIC)).toBe(true);
    expect(isHttpsOrigin(LOOPBACK)).toBe(false);
    expect(isHttpsOrigin("not a url")).toBe(false);
    expect(isHttpsOrigin(null)).toBe(false);
  });
});

describe("readPaperclipReachability", () => {
  it("reads a declared mode and normalizes the public url", () => {
    expect(
      readPaperclipReachability({
        paperclipReachability: { mode: "public_https", publicUrl: "https://x.example/api/" },
      }),
    ).toEqual({ mode: "public_https", publicUrl: "https://x.example" });
  });

  it("returns null rather than throwing for absent or malformed config", () => {
    expect(readPaperclipReachability(null)).toBeNull();
    expect(readPaperclipReachability({})).toBeNull();
    expect(readPaperclipReachability({ paperclipReachability: {} })).toBeNull();
    expect(readPaperclipReachability({ paperclipReachability: { mode: "nonsense" } })).toBeNull();
    expect(readPaperclipReachability("string")).toBeNull();
  });
});

describe("defaultReachabilityMode", () => {
  it("keeps local on loopback and sends remote to the public origin", () => {
    expect(defaultReachabilityMode(false)).toBe("loopback");
    expect(defaultReachabilityMode(true)).toBe("public_https");
  });
});

describe("resolvePaperclipOrigin", () => {
  it("leaves a local target on the host origin, which is today's behaviour", () => {
    expect(
      resolvePaperclipOrigin({
        isRemoteTarget: false,
        loopbackOrigin: LOOPBACK,
        publicOrigin: PUBLIC,
      }),
    ).toEqual({ mode: "loopback", origin: LOOPBACK });
  });

  it("gives a remote target the public origin without any config", () => {
    expect(
      resolvePaperclipOrigin({
        isRemoteTarget: true,
        loopbackOrigin: LOOPBACK,
        publicOrigin: PUBLIC,
      }),
    ).toEqual({ mode: "public_https", origin: PUBLIC });
  });

  it("prefers the environment's own publicUrl over the host default", () => {
    expect(
      resolvePaperclipOrigin({
        isRemoteTarget: true,
        reachability: { mode: "public_https", publicUrl: "https://tenant.example" },
        loopbackOrigin: LOOPBACK,
        publicOrigin: PUBLIC,
      }).origin,
    ).toBe("https://tenant.example");
  });

  it("refuses a non-HTTPS public origin rather than leaking a bearer token in clear text", () => {
    const resolved = resolvePaperclipOrigin({
      isRemoteTarget: true,
      loopbackOrigin: LOOPBACK,
      publicOrigin: "http://insecure.example",
    });
    expect(resolved.origin).toBeNull();
    expect(resolved.unresolvedReason).toBe("missing_public_url");
  });

  it("reports an unresolved public origin instead of silently falling back to loopback", () => {
    const resolved = resolvePaperclipOrigin({
      isRemoteTarget: true,
      loopbackOrigin: LOOPBACK,
      publicOrigin: null,
    });
    expect(resolved.origin).toBeNull();
    expect(resolved.unresolvedReason).toBe("missing_public_url");
  });

  it("honours an explicit loopback mode even on a remote target", () => {
    expect(
      resolvePaperclipOrigin({
        isRemoteTarget: true,
        reachability: { mode: "loopback" },
        loopbackOrigin: LOOPBACK,
        publicOrigin: PUBLIC,
      }),
    ).toEqual({ mode: "loopback", origin: LOOPBACK });
  });

  it("keeps bridge mode on the host origin until the bridge rewrites it (CH-7)", () => {
    expect(
      resolvePaperclipOrigin({
        isRemoteTarget: true,
        reachability: { mode: "bridge" },
        loopbackOrigin: LOOPBACK,
        publicOrigin: PUBLIC,
      }),
    ).toEqual({ mode: "bridge", origin: LOOPBACK });
  });

  it("reports a missing loopback origin", () => {
    const resolved = resolvePaperclipOrigin({ isRemoteTarget: false, loopbackOrigin: null });
    expect(resolved.origin).toBeNull();
    expect(resolved.unresolvedReason).toBe("missing_loopback_url");
  });
});

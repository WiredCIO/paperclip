import { describe, expect, it, vi } from "vitest";
import {
  loadGitHubGrantMetadata,
  loadGitHubPersonalAccessTokenIdentity,
} from "../services/tool-access.js";

function json(value: unknown, next = false): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
      ...(next ? { link: '<https://api.github.com/next>; rel="next"' } : {}),
    },
  });
}

describe("GitHub grant metadata", () => {
  it("lists every page of installations and repositories, persisting only display metadata", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const secondPage = url.searchParams.get("page") === "2";
      if (url.pathname === "/user") return json({ id: 42, login: "octocat", avatar_url: "https://avatars.example/octocat" });
      if (url.pathname === "/user/installations") {
        return json({ installations: secondPage
          ? [{ id: 102, repository_selection: "all", account: { login: "octocat" } }]
          : [{ id: 101, repository_selection: "selected", html_url: "https://github.com/settings/installations/101", account: { login: "paperclipai" } }],
        }, !secondPage);
      }
      if (url.pathname === "/user/installations/101/repositories") {
        return json({ total_count: 2, repositories: secondPage
          ? [{ id: 2, full_name: "paperclipai/b", private: true, description: "must-not-persist", clone_url: "must-not-persist" }]
          : [{ id: 1, full_name: "paperclipai/a", private: false }],
        }, !secondPage);
      }
      if (url.pathname === "/user/installations/102/repositories") {
        return json({ total_count: 1, repositories: [{ id: 3, full_name: "octocat/c" }] });
      }
      throw new Error(`Unexpected GitHub path: ${url.pathname}`);
    });

    const metadata = await loadGitHubGrantMetadata("ghu_secret", request, "paperclip-development");
    expect(metadata).toMatchObject({
      userId: "42",
      login: "octocat",
      installationCount: 2,
      repositoryCount: 3,
      repositorySelection: "mixed",
      installationIds: ["101", "102"],
      installationOwnerLogins: ["paperclipai", "octocat"],
      repositories: [
        { id: "3", fullName: "octocat/c", installationId: "102" },
        { id: "1", fullName: "paperclipai/a", installationId: "101", private: false },
        { id: "2", fullName: "paperclipai/b", installationId: "101", private: true },
      ],
      installationUrl: "https://github.com/apps/paperclip-development/installations/new",
      managementUrl: "https://github.com/settings/installations/101",
      appSlug: "paperclip-development",
      webhookHealth: "pending",
    });
    expect(metadata.repositories[0]).not.toHaveProperty("private");
    expect(JSON.stringify(metadata)).not.toContain("must-not-persist");
    expect(request).toHaveBeenCalledTimes(6);
    for (const [input, init] of request.mock.calls) {
      expect(new URL(String(input)).origin).toBe("https://api.github.com");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghu_secret");
    }
  });

  it("recovers a legacy grant's app chooser from GitHub installation metadata", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 42, login: "octocat" }))
      .mockResolvedValueOnce(json({ installations: [{ id: 101, app_slug: "paperclip-staging", repository_selection: "selected" }] }))
      .mockResolvedValueOnce(json({ repositories: [{ id: 1, full_name: "octocat/a" }] }));
    await expect(loadGitHubGrantMetadata("ghu_secret", request)).resolves.toMatchObject({
      appSlug: "paperclip-staging",
      installationUrl: "https://github.com/apps/paperclip-staging/installations/new",
    });
  });

  it("requires at least one installation with an accessible repository", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/user")
      ? json({ id: 42, login: "octocat" })
      : json({ installations: [] }));
    await expect(loadGitHubGrantMetadata("ghu_secret", request)).rejects.toMatchObject({
      details: expect.objectContaining({ code: "github_installation_required" }),
    });
  });

  it("does not report a partial repository list when a later page fails", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 42, login: "octocat" }))
      .mockResolvedValueOnce(json({ installations: [{ id: 101, repository_selection: "selected" }] }))
      .mockResolvedValueOnce(json({ repositories: [{ id: 1, full_name: "octocat/a" }] }, true))
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    await expect(loadGitHubGrantMetadata("ghu_secret", request)).rejects.toMatchObject({
      details: expect.objectContaining({ code: "github_access_check_failed" }),
    });
  });
});

describe("GitHub personal access token identity", () => {
  it("records the token owner's account, with no installation and a tool-only marker", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      json({ id: 7, login: "WiredCIOAppDev", avatar_url: "https://avatars.example/bot" }));

    await expect(loadGitHubPersonalAccessTokenIdentity("github_pat_abc", request)).resolves.toEqual({
      userId: "7",
      login: "WiredCIOAppDev",
      avatarUrl: "https://avatars.example/bot",
      installationCount: 0,
      repositoryCount: 0,
      repositorySelection: "none",
      installationIds: [],
      installationOwnerLogins: [],
      tokenKind: "personal_access_token",
    });
    expect(request).toHaveBeenCalledTimes(1);
    const [input, init] = request.mock.calls[0]!;
    expect(String(input)).toBe("https://api.github.com/user");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github_pat_abc");
  });

  it("does not double the Bearer prefix when the pasted value already has one", async () => {
    const request = vi.fn<typeof fetch>(async () => json({ id: 7, login: "WiredCIOAppDev" }));
    await loadGitHubPersonalAccessTokenIdentity("Bearer github_pat_abc", request);
    expect(new Headers(request.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer github_pat_abc");
  });

  it("rejects a token GitHub does not accept with a distinct code", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("Bad credentials", { status: 401 }));
    await expect(loadGitHubPersonalAccessTokenIdentity("github_pat_revoked", request)).rejects.toMatchObject({
      details: expect.objectContaining({ code: "github_personal_access_token_rejected" }),
    });
  });

  it("reports other GitHub failures and malformed accounts separately from a rejected token", async () => {
    await expect(loadGitHubPersonalAccessTokenIdentity(
      "github_pat_abc",
      vi.fn<typeof fetch>(async () => new Response("Unavailable", { status: 503 })),
    )).rejects.toMatchObject({ details: expect.objectContaining({ code: "github_access_check_failed" }) });
    await expect(loadGitHubPersonalAccessTokenIdentity(
      "github_pat_abc",
      vi.fn<typeof fetch>(async () => json({ jsonrpc: "2.0", result: { tools: [] } })),
    )).rejects.toMatchObject({ details: expect.objectContaining({ code: "github_bad_response" }) });
  });
});

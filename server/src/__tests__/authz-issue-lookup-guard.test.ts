import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard for issue lookups in route handlers (WIR-124).
 *
 * A route that loads an issue by id and then responds without asking an
 * access helper leaks the issue: to another tenant, or to an operator whose
 * project visibility hides it. This test scans every route file for
 * `<issueService>.getById(` and `getIssueById(` and fails when the handler
 * sends a non-404 response before any access helper runs.
 *
 * A lookup passed straight into `getAccessibleResource(...)` or
 * `getVisibleIssue(...)` is gated by that call. A 404 sent before the helper
 * is fine: it is the "does not exist" answer.
 */

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");

const ACCESS_HELPERS = [
  "getAccessibleResource",
  "getVisibleIssue",
  "assertIssueReadAllowed",
  "isIssueHiddenByProjectVisibility",
  "filterIssuesForActor",
  "decideIssueAccess",
  "assertAgentIssueMutationAllowed",
  "assertIssueWriteInfluenceAllowed",
  "assertAgentIssueCommentAllowed",
];
const ACCESS_HELPER_CALL = new RegExp(`\\b(?:${ACCESS_HELPERS.join("|")})\\(`);
const WRAPPING_HELPER_CALL = /\b(?:getAccessibleResource|getVisibleIssue)\(/;
const RESPONSE = /\bres\s*\.\s*(?:status|json|send|end|sendStatus)\(|\.pipe\(res\)/;
const NOT_FOUND = /\b404\b/;
// A route handler registered at the router's indentation ends here.
const HANDLER_END = /^\s{2}(?:\}\)|\);|router\.)/;

// "<file>:<trimmed lookup line>" for lookups that are not a request reading an
// issue it has not yet been authorized for. Each needs a reason.
const REVIEWED_LOOKUPS = new Set([
  // Harness cleanup callbacks; they never respond to the request.
  "company-skills.ts:const issue = await issues.getById(issueId);",
  // Resolver helper; its caller wraps it in getAccessibleResource and then
  // assertIssueCostReadAllowed, which maps a visibility denial to 404.
  "costs.ts:return issues.getById(rawId);",
  // Wakes members of a hold whose root issue the route already authorized.
  "issue-tree-control.ts:const issue = await issuesSvc.getById(member.issueId);",
  // Suggested-task parent on a write path; board write gating is T5b (WIR-971).
  "issues.ts:: await svc.getById(explicitParentIssueId);",
  // Task-watchdog agent scope validation; only rejects, never returns the issue.
  "issues.ts:const sourceIssue = await svc.getById(scope.watchedIssueId);",
  "issues.ts:? await svc.getById(scope.watchdogIssueId)",
  // Re-fetches of an issue the handler already gated.
  "issues.ts:const currentIssue = await svc.getById(issue.id);",
  "issues.ts:(await svc.getById(currentIssue.id).catch((err) => {",
]);

export function findUngatedIssueLookups(file: string, source: string): string[] {
  const lines = source.split("\n");
  const serviceNames = [...source.matchAll(/const (\w+) = issueService\(/g)].map((match) => match[1]);
  const lookup = new RegExp(
    [...serviceNames.map((name) => `\\b${name}\\.getById\\(`), "\\bgetIssueById\\("].join("|"),
  );
  const ungated: string[] = [];
  lines.forEach((line, index) => {
    const at = line.search(lookup);
    if (at < 0) return;
    if (/^\s*(?:\/\/|\*)/.test(line) || /function getIssueById\(/.test(line)) return;
    if (REVIEWED_LOOKUPS.has(`${file}:${line.trim()}`)) return;
    // The statement the lookup belongs to, from the previous `;` onwards.
    const statementLead = [...lines.slice(Math.max(0, index - 4), index), line.slice(0, at)]
      .join("\n")
      .split(";")
      .pop()!;
    if (WRAPPING_HELPER_CALL.test(statementLead)) return;
    for (let next = index + 1; next < lines.length; next += 1) {
      const text = lines[next]!;
      if (ACCESS_HELPER_CALL.test(text)) return;
      if (RESPONSE.test(text) && !NOT_FOUND.test(text)) {
        ungated.push(`${file}:${index + 1} (responds at line ${next + 1})`);
        return;
      }
      if (HANDLER_END.test(text)) return;
    }
  });
  return ungated;
}

function routeFiles() {
  return readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".ts") && name !== "authz.ts");
}

describe("issue lookup access guard", () => {
  it("requires an access helper between an issue lookup and the response", () => {
    const ungated = routeFiles().flatMap((file) =>
      findUngatedIssueLookups(file, readFileSync(join(ROUTES_DIR, file), "utf8")),
    );
    expect(
      ungated,
      "A route loads an issue and responds without an access helper, which leaks the issue "
        + "across tenants or past project visibility. Use getVisibleIssue (routes/authz.ts), or "
        + "getAccessibleResource followed by assertIssueReadAllowed. "
        + `Offending sites: ${ungated.join(", ")}`,
    ).toEqual([]);
  });

  it("catches a handler that responds with an unchecked issue", () => {
    const source = [
      "  const svc = issueService(db);",
      "  router.get(\"/issues/:id/thing\", async (req, res) => {",
      "    const issue = await svc.getById(req.params.id);",
      "    if (!issue) {",
      "      res.status(404).json({ error: \"Issue not found\" });",
      "      return;",
      "    }",
      "    res.json(issue);",
      "  });",
    ].join("\n");
    expect(findUngatedIssueLookups("fixture.ts", source)).toEqual(["fixture.ts:3 (responds at line 8)"]);
  });

  it("accepts the gated shapes", () => {
    const source = [
      "  const svc = issueService(db);",
      "  router.get(\"/a/:id\", async (req, res) => {",
      "    const issue = await getVisibleIssue(req, res, access, svc.getById(id), \"Issue not found\");",
      "    if (!issue) return;",
      "    res.json(issue);",
      "  });",
      "  router.get(\"/b/:id\", async (req, res) => {",
      "    const issue = await svc.getById(id);",
      "    if (!issue) { res.status(404).json({ error: \"Issue not found\" }); return; }",
      "    if (!(await assertIssueReadAllowed(req, res, issue))) return;",
      "    res.json(issue);",
      "  });",
    ].join("\n");
    expect(findUngatedIssueLookups("fixture.ts", source)).toEqual([]);
  });

  it("keeps the reviewed-lookup list free of stale entries", () => {
    const sources = new Map(routeFiles().map((file) => [file, readFileSync(join(ROUTES_DIR, file), "utf8")]));
    const stale = [...REVIEWED_LOOKUPS].filter((entry) => {
      const split = entry.indexOf(":");
      const source = sources.get(entry.slice(0, split));
      const text = entry.slice(split + 1);
      return !source?.split("\n").some((line) => line.trim() === text);
    });
    expect(stale, `Reviewed lookups no longer in the code: ${stale.join(", ")}`).toEqual([]);
  });
});

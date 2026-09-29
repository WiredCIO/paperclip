# @wiredcio/paperclip-mcp

Paperclip's MCP server plus the tools it does not ship: **routines** and **work
products**. Everything upstream provides is included — this composes
`@paperclipai/mcp-server`, it does not replace it.

## Why a separate package

Upstream's tool list is a frozen surface. Every entry in
`packages/mcp-server/src/tools.ts` is a `legacy_mcp_alias` in the runner's
capability ledger, pinned at **42 rows** by a hardcoded count and required to
fold into a capability:

```js
const expectedCounts = { capabilities: 155, evaluations: 106, legacyMcpAliases: 42 };
```

Upstream is migrating off that surface, so adding tools there means bumping a
deliberate guardrail, inventing traceability mappings, and diverging in files
upstream actively maintains. Wrapping costs one re-export in
`packages/mcp-server/src/index.ts` and nothing else, so upstream merges stay
clean.

If upstream ever ships a tool of the same name, the composer **throws** rather
than silently shadowing it — the winner would otherwise depend on array order.
That error is the signal to delete the local copy.

## Usage

```sh
npx -y @wiredcio/paperclip-mcp
```

Configuration is identical to upstream's, read from the environment:

- `PAPERCLIP_API_URL` — base URL, e.g. `http://localhost:3100`
- `PAPERCLIP_API_KEY` — bearer token; for a person, their **board API key**
- `PAPERCLIP_COMPANY_ID` — optional default company for company-scoped tools
- `PAPERCLIP_AGENT_ID` / `PAPERCLIP_RUN_ID` — optional

## Tools added here

Routines:

- `paperclipListRoutines`, `paperclipGetRoutine`, `paperclipCreateRoutine`,
  `paperclipUpdateRoutine`, `paperclipRunRoutine`, `paperclipListRoutineRuns`,
  `paperclipCreateRoutineTrigger`, `paperclipUpdateRoutineTrigger`

**Triggers are not part of the routine body.** `POST`/`PATCH` on a routine accept
a `triggers` key, ignore it, and return `200` — so a routine appears to accept a
new cron and silently keeps the old one, and a routine created without a trigger
never fires at all. Schedules change only through the trigger tools.

Work products:

- `paperclipListIssueWorkProducts`, `paperclipUpdateWorkProduct`

`reviewState` accepts `none`, `needs_board_review`, `approved`,
`changes_requested`.

## Giving a teammate access from their own Claude

Each person uses **their own board API key**. It is row-scoped to a user
(`board_api_keys.user_id`), hashed, revocable and expirable, so their existing
role and permissions apply unchanged and every call is attributable to them.
Do not share one key across a team — that collapses the audit trail and makes
revocation all-or-nothing.

1. **Add them to the company** in Paperclip with a role (`owner`, `admin`,
   `operator`, `viewer`) and the permissions they need. For someone who should
   create and route work but not reconfigure agents, `operator` with
   `tasks:assign`, `pipelines:write` and `agents:suggest-changes` is the usual
   shape — the `*:suggest-changes` permissions let them propose without
   committing.
2. **They generate a board API key** from their own Paperclip account.
3. **They register the server** with Claude Code:

   ```sh
   claude mcp add paperclip -- npx -y @wiredcio/paperclip-mcp
   ```

   with `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and optionally
   `PAPERCLIP_COMPANY_ID` in the environment.

### Network

The machine running the server must reach the Paperclip instance. On a
deployment bound to a tailnet (`PAPERCLIP_DEPLOYMENT_EXPOSURE=private`), **the
teammate's device has to be on the tailnet** — that is the real gating step, and
it is worth doing before issuing keys.

It also means claude.ai's hosted connectors cannot be used: they call out from
Anthropic's infrastructure and have no route to a private tailnet address. This
server runs locally over stdio beside Claude Code, which is why it works.
Exposing Paperclip publicly to change that would trade away the reason it is
private.

### Artifacts

Artifacts are not a Paperclip concept and this server does not touch them. They
belong to each person's Claude account, are private by default, and their
visibility across the organisation is a Claude setting.

## Publishing

`prepack` runs the esbuild bundle, so packing always ships a fresh
self-contained build. The workspace dependencies are **bundled in**: they are
`workspace:*` links whose local versions do not exist on the registry, so a
plain publish would hand every installer a resolution failure.

```sh
cd packages/wiredcio-mcp
npm publish --access public
```

Requires the `wiredcio` npm scope and an authenticated publish token.
`publishFromCi` is `false` in `scripts/release-package-manifest.json` — the fork's
CI has no credentials for this scope, and publishing is meant to be deliberate.

Verify the packed artifact before publishing; a bundle can build cleanly and
still fail to execute:

```sh
npm pack --pack-destination /tmp/packtest
cd /tmp/packtest && npm init -y && npm install ./wiredcio-paperclip-mcp-*.tgz
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | PAPERCLIP_API_URL=http://127.0.0.1:3100 PAPERCLIP_API_KEY=probe \
    node node_modules/@wiredcio/paperclip-mcp/dist/stdio.js
```

`tools/list` should return **54** tools. `npm ls` should show only
`@modelcontextprotocol/sdk` and `zod` — if any `@paperclipai/*` package appears,
the bundle did not inline it and the install will break for everyone else.

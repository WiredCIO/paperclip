// Build a self-contained dist for publishing to npm.
//
// This package depends on @paperclipai/mcp-server and @paperclipai/shared via
// `workspace:*`. That is fine inside the monorepo but cannot be published:
// pnpm rewrites the protocol to the local version at pack time, and the fork's
// local versions are not versions that exist on the registry. Anyone running
// `npx @wiredcio/paperclip-mcp` would hit an install failure for a dependency
// they never asked about.
//
// Pinning to whatever upstream last published would also let the tool schemas
// drift from the validators they were built against, so the workspace code is
// bundled in instead. `zod` and the MCP SDK stay external so they resolve
// normally and dedupe against anything else the host installs.

import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "zod"],
  logLevel: "info",
};

// Clean here rather than via the `clean` script: that one is `rm -rf`, and npm
// runs prepack through cmd.exe on Windows, where it is not a command.
await rm(resolve(pkgRoot, "dist"), { recursive: true, force: true });
await mkdir(resolve(pkgRoot, "dist"), { recursive: true });

// No shebang banner: src/stdio.ts already starts with one and esbuild preserves
// it. A second `#!` lands on line 2, which is not a shebang but a syntax error
// — and it only surfaces when the packed binary runs, never at build time.
await build({
  ...shared,
  entryPoints: [resolve(pkgRoot, "src/stdio.ts")],
  outfile: resolve(pkgRoot, "dist/stdio.js"),
});

await build({
  ...shared,
  entryPoints: [resolve(pkgRoot, "src/index.ts")],
  outfile: resolve(pkgRoot, "dist/index.js"),
});

await writeFile(
  resolve(pkgRoot, "dist/index.d.ts"),
  "export * from \"../src/index.js\";\n",
  "utf8",
);

console.log("bundled dist/stdio.js and dist/index.js");

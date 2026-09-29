import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the Daytona agent toolchain image (CH-10).
 *
 * The image's own `RUN` steps already assert that every tool is present at its
 * pinned version, so a successful build is the version check. This test covers
 * what a build cannot: the properties that decide whether the build is
 * *reproducible* and whether the image keeps the contract the environment
 * depends on. Those regress silently, because loosening them still builds
 * — and on this repo the image is not built on every PR.
 *
 * Placed in the server suite rather than next to the Dockerfile because
 * `tests/runner-e2e` has its own vitest config and only runs in the scheduled
 * runner workflow, so a guard there would not gate a pull request.
 * `cloud-image-sentry.test.ts` sets the precedent for reading a Dockerfile from
 * here.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfilePath = path.join(repoRoot, "docker", "daytona-agent-toolchain", "Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");
const readme = readFileSync(
  path.join(repoRoot, "docker", "daytona-agent-toolchain", "README.md"),
  "utf8",
);

/** Collapses line continuations so a multi-line `RUN` reads as one string. */
const flattened = dockerfile.replace(/\\\r?\n\s*/g, " ");

/**
 * Instructions only, with comment lines removed, for the negative assertions.
 * The comments deliberately name the things that must not appear — the whole
 * point of `LD_LIBRARY_PATH` and `paperclip-runnerd` showing up in this file is
 * to record why they are absent — so scanning the raw text would fail on its
 * own documentation. Only a line whose first non-space character is `#` is
 * dropped, which leaves the `#!/bin/sh` inside the pac shim's `printf` intact.
 */
const instructions = dockerfile
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

function buildArgDefault(name: string): string | null {
  const match = new RegExp(`^ARG ${name}(?:=(.*))?$`, "m").exec(dockerfile);
  if (!match) throw new Error(`Dockerfile declares no ARG ${name}`);
  return match[1] ?? null;
}

describe("Daytona agent toolchain image", () => {
  it("pins the syntax frontend and every base image by digest", () => {
    const syntax = /^# syntax=(\S+)$/m.exec(dockerfile);
    expect(syntax, "Dockerfile must declare a syntax frontend").not.toBeNull();
    expect(syntax![1]).toMatch(/@sha256:[0-9a-f]{64}$/);

    const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);
    expect(bases.length).toBeGreaterThan(0);
    for (const base of bases) {
      // A tag alone is an annotation, not an identity: it can be moved under us.
      expect(base, `FROM ${base} is not pinned to a digest`).toMatch(
        /@sha256:[0-9a-f]{64}$/,
      );
    }
  });

  it("requires a reviewed .NET SDK digest instead of shipping a default", () => {
    // The point of the arg is that a human fetched and checked the digest
    // Microsoft publishes. A default would be a hash nobody verified, which
    // reads as a supply-chain control while providing none.
    expect(buildArgDefault("DOTNET_SDK_SHA512")).toBeNull();
    expect(flattened).toContain("sha512sum -c /tmp/dotnet.sha512");
    // ...and the build must fail closed when it is absent, not download anyway.
    expect(flattened).toMatch(/\[ -n "\$\{DOTNET_SDK_SHA512:-\}" \]/);
    expect(readme).toContain("dotnet-sdk-10.0.401-linux-x64.tar.gz.sha512");
  });

  it("pins each tool to an exact version", () => {
    for (const arg of [
      "GROK_VERSION",
      "CLAUDE_CODE_VERSION",
      "DOTNET_SDK_VERSION",
      "PAC_VERSION",
    ]) {
      const value = buildArgDefault(arg);
      expect(value, `${arg} must carry a default version`).not.toBeNull();
      // Exact, not a range and not a moving tag.
      expect(value!, `${arg}=${value} is not an exact version`).toMatch(
        /^\d+\.\d+\.\d+$/,
      );
    }
    // npm resolves a bare name to `latest`, which would defeat all of the above.
    expect(flattened).toContain('"@xai-official/grok@${GROK_VERSION}"');
    expect(flattened).toContain('"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
  });

  it("keeps the toolchain reachable with no agent env bindings", () => {
    // The previous custom image for this toolchain was abandoned because
    // Daytona passes no environment at create time, so DOTNET_ROOT,
    // LD_LIBRARY_PATH and PATH had to be restated in every agent's
    // adapter_config.env. Re-introducing that dependence would repeat it.
    expect(instructions).not.toContain("LD_LIBRARY_PATH");

    // ICU from the distro is what removes the LD_LIBRARY_PATH requirement.
    expect(flattened).toContain("libicu76");

    // Each executable must resolve on the default PATH.
    expect(flattened).toContain("ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet");
    expect(flattened).toContain("/usr/local/bin/pac");

    // The pac shim must export DOTNET_ROOT itself: an adapter execs a bare
    // command with no login profile, so it cannot rely on /etc/profile.d.
    expect(flattened).toContain(
      'printf \'#!/bin/sh\\nexport DOTNET_ROOT=/usr/share/dotnet\\nexec /usr/local/lib/pac/pac "$@"\\n\'',
    );

    // And the promise is re-checked as the unprivileged user under a bare shell.
    expect(dockerfile).toContain("USER daytona");
    expect(flattened).toMatch(/RUN \/bin\/sh -c 'set -eu;[\s\S]*command -v "\$command_name"/);
  });

  it("guards the Grok device-login flag the adapter hardcodes", () => {
    // server/src/services/login-command.ts routes grok_local through
    // `grok login --device-auth`, hardcoded in the adapter and again in the
    // Daytona plugin. If a CLI bump drops the flag, sign-in breaks with no
    // useful error, so the image refuses to build instead.
    expect(flattened).toContain('grok login --help | grep -q -- "--device-auth"');
  });

  it("is not the runner image", () => {
    // grok_local is a direct adapter and the runner has no Grok backend, so
    // this image must not grow runnerd or the provider pack by copy-paste.
    expect(instructions).not.toContain("paperclip-runnerd");
    expect(instructions).not.toContain("provider-pack");
  });
});

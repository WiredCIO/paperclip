# Paperclip Daytona agent toolchain image

The Daytona fleet sandbox base plus the four tools an S4Water-class agent needs:
the Grok Build CLI, Claude Code, the Power Platform CLI and the .NET SDK.

This is **not** the runner image. It contains no `paperclip-runnerd` and no
provider pack, because `grok_local` runs as a direct adapter and the runner has
no Grok backend (`packages/paperclip-runner/src/backends/native-backend-factory.ts`
throws for anything but `opencode`, `acpx` and `codex`). For runner-backed
agents use [`docker/daytona-runner`](../daytona-runner/README.md) instead.

## Pinned versions

Matched to what the production VM runs as of 2026-09-25, so moving an agent onto
a sandbox is not also a silent toolchain upgrade.

| Tool | Version | Build arg |
| --- | --- | --- |
| Grok Build CLI | 1.0.40 | `GROK_VERSION` |
| Claude Code | 2.1.282 | `CLAUDE_CODE_VERSION` |
| .NET SDK | 10.0.401 | `DOTNET_SDK_VERSION` |
| Power Platform CLI | 2.12.2 | `PAC_VERSION` |
| Node | from the base image (>= 22 asserted) | — |

## The environment contract: there isn't one

An agent on this image needs **no toolchain entries in `adapter_config.env`** —
no `DOTNET_ROOT`, no `LD_LIBRARY_PATH`, no rewritten `PATH`.

That is deliberate, and it is the difference between this image and the custom
sandbox image that was tried for this toolchain once before and abandoned.
Daytona ignores an image `ENTRYPOINT` and passes no environment at create time,
so the previous attempt pushed all three variables into every agent's config,
where a single wrong value produces `Process terminated.` and nothing else. The
same failure is visible on the VM today: `pac --version` there reports
*"Couldn't find a valid ICU package installed on the system"* whenever
`LD_LIBRARY_PATH` is not pointing at the hand-unpacked ICU directory.

So instead:

- `libicu76` comes from the distro, so .NET finds ICU with no variable set.
- every executable resolves at `/usr/local/bin`, already on the default `PATH`
  for both `root` and the `daytona` user.
- `pac` is a shim that exports `DOTNET_ROOT` itself, so it works from a bare
  `sh -c` with no profile loaded — which is how an adapter invokes a command.

The final build stage re-runs the checks as the unprivileged `daytona` user
under `/bin/sh -c` precisely to keep that promise honest.

## Build

You must supply `DOTNET_SDK_SHA512`. It has no default, and the build fails
without it:

```bash
curl -fsSL https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.401/dotnet-sdk-10.0.401-linux-x64.tar.gz.sha512
```

Review that value, then:

```bash
docker buildx build \
  --platform linux/amd64 \
  --build-arg DOTNET_SDK_SHA512="<the reviewed digest>" \
  --build-arg PAPERCLIP_TOOLCHAIN_SOURCE_REVISION="$(git rev-parse HEAD)" \
  --tag ghcr.io/wiredcio/paperclip-agent-toolchain:grok1.0.40-dotnet10.0.401-pac2.12.2 \
  --file docker/daytona-agent-toolchain/Dockerfile \
  .
```

There is no default digest on purpose. A hash committed by someone who could not
fetch and check it is not a supply-chain control; it is decoration that makes
the build look verified. Requiring the arg forces exactly one human to look at
the value Microsoft publishes.

amd64 only, matching `daytona-runner`: the pinned base digest is the reviewed
linux/amd64 manifest, and the build refuses any other architecture rather than
producing an image that fails at run time.

## Verify

The build already asserts the exact version of all four tools and fails if any
drifts, so a successful build *is* the version check. To confirm by hand:

```bash
docker run --rm --platform linux/amd64 --entrypoint sh \
  ghcr.io/wiredcio/paperclip-agent-toolchain:grok1.0.40-dotnet10.0.401-pac2.12.2 \
  -c 'grok --version; claude --version; pac --version; dotnet --version'
```

Use `--entrypoint sh` for a local probe: the Daytona base image ships its own
long-running sandbox entrypoint.

## Publish and register as a snapshot

Push to a registry Daytona can pull, then turn it into a Daytona **snapshot** —
not an environment `image`.

This is the second reason the earlier attempt was abandoned: an image-backed
environment made Daytona pull the image on every run. A snapshot is
materialised once on Daytona's side, and the plugin's manifest already declares
`templateRefKind: "snapshot"`.

Use the environment editor's **Configure image** flow to produce the snapshot,
then set it as the environment's snapshot.

**Set CPU and memory on the snapshot, not the environment.** A snapshot bakes in
its own resource allocation and the plugin drops per-environment resource
settings at create time — see `validateRuntimeResourceRequest` in
`packages/plugins/sandbox-providers/daytona/src/plugin.ts`, which permits a
resource request to pass silently when a snapshot is configured, and
`validateResourceRequest`, which rejects it at save time for a non-image
environment with: *"Daytona resource settings require image-backed sandbox
creation."*

## Size budget: 10 GiB per sandbox

The Daytona account this fork uses **caps disk at 10 GiB per sandbox**. A probe
requesting more fails with:

```
Disk request 20GB exceeds maximum allowed per sandbox (10GB).
Need higher resource limits per-sandbox? Contact us at support@daytona.io
```

So the whole working set has to fit in 10 GiB: this image, the workspace clone,
the NuGet cache and any `obj/bin` output. For reference the previous D365 image
(`ghcr.io/wiredcio/agent-runtime-connectability`) is 3.79 GB and ran on disk 10.

Measure before snapshotting:

```bash
docker image inspect --format '{{.Size}}' ghcr.io/wiredcio/paperclip-agent-toolchain:grok1.0.40-dotnet10.0.401-pac2.12.2
```

If it grows much past ~4 GB, the .NET SDK is the place to look first — it is by
far the largest component, and a restore of a wide package graph is the most
likely way to exhaust the remainder at run time. Raising the cap is a
support@daytona.io conversation, not a config change.

Memory is separately constrained by the plugin's schema, which accepts only
1, 2, 4 or 8 GiB. **8 is confirmed working on this plan** — disk is the only
resource the account caps below what the schema allows.

### Confirmed working environment

Provisioned and started a sandbox on 2026-09-25 (`daytonaio/sandbox:0.8.0`,
lease released cleanly):

| Setting | Value |
| --- | --- |
| `cpu` | 4 |
| `memory` | 8 |
| `disk` | 10 (the cap) |
| `target` | `us` |
| `apiKey` | the `Daytona` company secret, by reference |

Keep `target: us`. A probe that requests too much disk fails with **"Region not
found"**, which reads like a bad `target` and is not — the same `us` value is in
both the successful 2026-09-25 lease and the earlier 2026-09-16 one. Check the
disk request before touching the region.

## Bump procedure

1. Change the version build arg in the `Dockerfile`, and for .NET fetch the new
   `.sha512` and review it.
2. Rebuild with a new immutable tag. Never move an existing tag — a sandbox that
   pulls a changed tag under the same name is unreproducible.
3. Re-snapshot and repoint the environment.
4. **For a Grok bump, check the device-login prompt still parses.** Run
   `grok login --device-auth` in a sandbox from the new snapshot and confirm the
   sign-in card in Paperclip shows a code. The parser in
   `packages/adapters/grok-local/src/server/device-login-parse.ts` matches the
   CLI's output exactly; if the wording changes, the card renders blank until the
   300 s login timeout and reports nothing useful. The final build stage asserts
   that `--device-auth` still exists, which catches the flag disappearing but not
   the prompt text changing.

On 1.0.40 `grok login --help` lists `--device-auth` as canonical with
`--device-code` as an alias, so the command Paperclip hardcodes is correct even
though the CLI's own "not signed in" message suggests the alias.

## Status: not yet built or run

Neither acceptance criterion involving a live sandbox has been met, and this
README should not imply otherwise.

- The image has **not been built**. There is no Docker daemon on the authoring
  machine, and the build needs a reviewed `DOTNET_SDK_SHA512` that must come
  from a human.
- It has **not been run in a sandbox**. The instance currently has exactly one
  environment — `Local`, driver `local` — and no Daytona environment at all, so
  there is nowhere to create a sandbox from a snapshot yet. The Daytona plugin
  itself is installed and ready (`paperclip.daytona-sandbox-provider` v0.1.7,
  manifest `supportsLoginPty: true`), so what is missing is an environment and
  the Daytona credentials behind it, not plugin support.

Remaining before #38 can be closed: build with a reviewed digest, publish,
create a Daytona environment, snapshot, and run the four `--version` checks
inside a sandbox created from it.

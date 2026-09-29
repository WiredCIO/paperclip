# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Agent toolchain image for Daytona sandboxes (CH-10, issue #38).
#
# This is the Daytona fleet sandbox base plus the four tools an S4Water-class
# agent needs: the Grok Build CLI, Claude Code, the Power Platform CLI and the
# .NET SDK. It deliberately does NOT contain paperclip-runnerd or the runner
# provider pack — `grok_local` runs as a direct adapter and the runner has no
# Grok backend (packages/paperclip-runner/src/backends/native-backend-factory.ts).
# Use docker/daytona-runner/Dockerfile for runner-backed agents instead.
#
# ── Why every tool lands on the default PATH, with no env bindings ───────────
# A custom sandbox image for this toolchain was tried once before and abandoned:
# Daytona ignores an image ENTRYPOINT and passes no environment at create time,
# so the previous attempt needed DOTNET_ROOT, LD_LIBRARY_PATH and a rewritten
# PATH threaded through each agent's `adapter_config.env`. That is fragile —
# every new agent has to re-declare them, and a typo produces a "Process
# terminated." with no explanation.
#
# So this image takes the environment out of the contract entirely:
#   * libicu comes from the distro, not an unpacked .deb, so .NET needs no
#     LD_LIBRARY_PATH. (On the current VM, `pac --version` fails with
#     "Couldn't find a valid ICU package installed on the system" whenever that
#     variable is missing or wrong.)
#   * every executable is reachable at /usr/local/bin, already on the default
#     PATH for both root and the `daytona` user.
#   * `pac` is a shim that exports DOTNET_ROOT itself, so it works from a bare
#     `sh -c` with no profile loaded — which is how an adapter invokes it.
# An agent using this image should need NO toolchain entries in adapter_config.env.
#
# Pins mirror what the production VM runs today (2026-09-25), so moving an agent
# onto a sandbox is not also a toolchain upgrade.

FROM daytonaio/sandbox:0.8.0@sha256:eadf88e4391072b7ad4bed27d9cadfc9fe9d8ed375d9219d34c2ccb518f213e3

USER root

# .NET refuses to start without ICU unless globalization is disabled, which
# would change string comparison and date formatting under the agent. Debian 13
# carries ICU 76, matching the libicu76 the VM unpacks by hand today.
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends libicu76; \
    rm -rf /var/lib/apt/lists/*

# ── .NET SDK ─────────────────────────────────────────────────────────────────
# DOTNET_SDK_SHA512 has NO default on purpose. Microsoft publishes the digest
# next to the tarball; it must be fetched and reviewed by a human, and the build
# fails without it. A default here would be a hash nobody checked, which is
# worse than no hash at all. The README says where to get it.
ARG DOTNET_SDK_VERSION=10.0.401
ARG DOTNET_SDK_SHA512
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    [ "$arch" = "amd64" ] || { echo "FATAL: .NET pin only covers amd64, not $arch" >&2; exit 1; }; \
    [ -n "${DOTNET_SDK_SHA512:-}" ] || { \
      echo "FATAL: build-arg DOTNET_SDK_SHA512 is required; see docker/daytona-agent-toolchain/README.md" >&2; \
      exit 1; }; \
    url="https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_SDK_VERSION}/dotnet-sdk-${DOTNET_SDK_VERSION}-linux-x64.tar.gz"; \
    curl -fsSL "$url" -o /tmp/dotnet.tar.gz; \
    printf '%s  /tmp/dotnet.tar.gz\n' "${DOTNET_SDK_SHA512}" > /tmp/dotnet.sha512; \
    sha512sum -c /tmp/dotnet.sha512; \
    mkdir -p /usr/share/dotnet; \
    tar -xzf /tmp/dotnet.tar.gz -C /usr/share/dotnet; \
    rm -f /tmp/dotnet.tar.gz /tmp/dotnet.sha512; \
    ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet; \
    chmod -R a+rX /usr/share/dotnet

ENV DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

# ── Power Platform CLI ───────────────────────────────────────────────────────
# Installed as a global tool into a fixed path, then fronted by a shim. The
# launcher `dotnet tool install` generates resolves .NET relative to its own
# location and can miss DOTNET_ROOT when invoked from a non-login shell; the
# shim removes that variable from the caller's contract.
ARG PAC_VERSION=2.12.2
RUN set -eu; \
    dotnet tool install Microsoft.PowerApps.CLI.Tool \
      --version "${PAC_VERSION}" \
      --tool-path /usr/local/lib/pac; \
    printf '#!/bin/sh\nexport DOTNET_ROOT=/usr/share/dotnet\nexec /usr/local/lib/pac/pac "$@"\n' > /usr/local/bin/pac; \
    chmod 755 /usr/local/bin/pac; \
    chmod -R a+rX /usr/local/lib/pac; \
    rm -rf /root/.dotnet/toolResolverCache /tmp/NuGetScratch /root/.nuget/packages

# ── Agent CLIs ───────────────────────────────────────────────────────────────
# Pinned to the versions the VM runs today. The Grok pin matters most: the
# device-login prompt parser (packages/adapters/grok-local/src/server/
# device-login-parse.ts) matches the CLI's output exactly, so a silent CLI
# upgrade can make the sign-in card render blank until the login times out.
ARG GROK_VERSION=1.0.40
ARG CLAUDE_CODE_VERSION=2.1.282
RUN set -eu; \
    npm install -g \
      "@xai-official/grok@${GROK_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    npm cache clean --force

# Belt and braces for shells that do read a profile. The image ENV above already
# covers exec'd processes; Daytona is documented as passing no env at create
# time, so neither mechanism is relied on alone.
RUN set -eu; \
    printf '%s\n' 'export DOTNET_ROOT=/usr/share/dotnet' \
      > /etc/profile.d/01-paperclip-agent-toolchain.sh; \
    chmod 0644 /etc/profile.d/01-paperclip-agent-toolchain.sh

# ── Build-time verification ──────────────────────────────────────────────────
# Assert the exact versions rather than mere presence: a floating install that
# still answers `--version` is the failure this pinning exists to prevent.
RUN set -eu; \
    for command_name in grok claude pac dotnet node npm git; do \
      command -v "$command_name" >/dev/null \
        || { echo "FATAL: $command_name not on PATH after build" >&2; exit 1; }; \
    done; \
    grok --version | grep -q "${GROK_VERSION}" \
      || { echo "FATAL: grok is not ${GROK_VERSION}: $(grok --version)" >&2; exit 1; }; \
    claude --version | grep -q "${CLAUDE_CODE_VERSION}" \
      || { echo "FATAL: claude is not ${CLAUDE_CODE_VERSION}: $(claude --version)" >&2; exit 1; }; \
    dotnet --version | grep -q "${DOTNET_SDK_VERSION}" \
      || { echo "FATAL: dotnet is not ${DOTNET_SDK_VERSION}: $(dotnet --version)" >&2; exit 1; }; \
    pac --version | grep -q "${PAC_VERSION}" \
      || { echo "FATAL: pac is not ${PAC_VERSION}" >&2; exit 1; }; \
    node -e "const [m]=process.versions.node.split('.').map(Number); if (m<22) { console.error('FATAL: node '+process.versions.node+' is older than 22'); process.exit(1); }"; \
    echo "root: all four tools present at pinned versions"

USER daytona

# The unprivileged user is the one that actually runs an agent, and it loads no
# login profile when an adapter execs a command. Everything below must therefore
# work from a bare `sh -c`, which is what this re-checks.
RUN /bin/sh -c 'set -eu; \
    for command_name in grok claude pac dotnet; do \
      command -v "$command_name" >/dev/null \
        || { echo "FATAL: $command_name not on PATH for the daytona user" >&2; exit 1; }; \
    done; \
    dotnet --version >/dev/null; \
    pac --version >/dev/null; \
    grok login --help | grep -q -- "--device-auth" \
      || { echo "FATAL: grok login no longer offers --device-auth; the Paperclip device-login command is hardcoded to it" >&2; exit 1; }; \
    echo "daytona user: toolchain usable with no profile and no env bindings"'

ARG PAPERCLIP_TOOLCHAIN_SOURCE_REVISION
LABEL org.opencontainers.image.revision="${PAPERCLIP_TOOLCHAIN_SOURCE_REVISION}" \
      org.opencontainers.image.title="paperclip-daytona-agent-toolchain" \
      io.paperclip.toolchain.grok="${GROK_VERSION}" \
      io.paperclip.toolchain.claude-code="${CLAUDE_CODE_VERSION}" \
      io.paperclip.toolchain.dotnet-sdk="${DOTNET_SDK_VERSION}" \
      io.paperclip.toolchain.pac="${PAC_VERSION}"

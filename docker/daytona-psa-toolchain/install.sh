#!/bin/sh
# Installs the toolchain AppDev needs to work on WiredCIO-PSA inside a Daytona
# sandbox: Node 22, npm, pnpm, Claude Code, git, gh, ripgrep, jq, curl, python3.
#
# Run as root on a Debian/Ubuntu base (daytonaio/sandbox is Debian-based):
#   sh install.sh
#
# Everything lands in /usr/local/bin or /usr/bin so it resolves under a bare
# non-login `sh -c`, which is how the adapter probes for `claude`. Nothing here
# depends on ~/.nvm, ~/.local or a profile file.
#
# Deliberately NOT installed: .NET, pac (PSA has no Dataverse code), Docker
# (Daytona cannot run it), Playwright browsers (e2e runs in GitHub Actions).
set -eu

CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.308}"
PNPM_VERSION="${PNPM_VERSION:-9.12.0}"
NODE_MAJOR="${NODE_MAJOR:-22}"

[ "$(id -u)" = "0" ] || { echo "FATAL: run as root" >&2; exit 1; }
command -v apt-get >/dev/null 2>&1 || { echo "FATAL: Debian/Ubuntu base required" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git ripgrep jq python3

# ── Node ─────────────────────────────────────────────────────────────────────
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$(node_major)" -lt "$NODE_MAJOR" ] || ! command -v npm >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y --no-install-recommends nodejs
fi

# ── GitHub CLI ───────────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update
  apt-get install -y --no-install-recommends gh
fi

rm -rf /var/lib/apt/lists/*

# ── npm globals ──────────────────────────────────────────────────────────────
# Point the global prefix at /usr/local so the binaries land in /usr/local/bin,
# already on the default PATH for root and the unprivileged user.
npm config set --global prefix /usr/local
npm install -g \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "pnpm@${PNPM_VERSION}"
npm cache clean --force

# ── Verify the way the adapter will see it: bare sh -c, unprivileged user ────
check='
  set -e
  node --version
  npm --version
  pnpm --version
  claude --version
  git --version
  gh --version | head -1
  rg --version | head -1
  jq --version
  python3 --version
'

echo "== verifying as root =="
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin sh -c "$check"

if id daytona >/dev/null 2>&1; then
  echo "== verifying as daytona =="
  su daytona -s /bin/sh -c "env -i PATH=/usr/local/bin:/usr/bin:/bin sh -c '$check'"
else
  echo "NOTE: no 'daytona' user in this image; skipped the unprivileged check" >&2
fi

echo "OK"

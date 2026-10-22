#!/bin/sh
# Upgrades Claude Code in a running Daytona sandbox to the latest npm release
# (or CLAUDE_CODE_VERSION if set). Runs as the unprivileged `daytona` user,
# which is how Paperclip's Daytona script window executes: it installs into the
# existing npm global prefix, escalating with passwordless sudo only when that
# prefix is not writable.
set -eu

CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-latest}"
PKG="@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

command -v npm >/dev/null 2>&1 || { echo "FATAL: npm not found" >&2; exit 1; }

echo "before: $(claude --version 2>/dev/null || echo 'not installed') at $(command -v claude || echo '-')"
PREFIX="$(npm prefix -g)"
echo "npm global prefix: $PREFIX"
echo "target: $(npm view "$PKG" version)"

if [ -w "$PREFIX/lib/node_modules" ] || [ -w "$PREFIX/lib" ]; then
  npm install -g "$PKG"
elif sudo -n true 2>/dev/null; then
  sudo -n env "PATH=$PATH" npm install -g --prefix "$PREFIX" "$PKG"
else
  echo "FATAL: $PREFIX is not writable and passwordless sudo is unavailable" >&2
  exit 1
fi

hash -r 2>/dev/null || true
echo "after: $(claude --version) at $(command -v claude)"

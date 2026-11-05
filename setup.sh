#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.mcp-docs-rag.indexer"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE="$(command -v node || true)"
PNPM="$(command -v pnpm || true)"

[[ -n "$NODE" ]] || { echo "node not found" >&2; exit 1; }
[[ -n "$PNPM" ]] || { echo "pnpm not found" >&2; exit 1; }

CONFIG_PATH="${DOCS_RAG_CONFIG:-$HOME/.config/mcp-docs-rag/config.yaml}"
[[ -f "$CONFIG_PATH" ]] || { echo "Config not found: $CONFIG_PATH" >&2; exit 1; }
CONFIG_PATH="$(cd "$(dirname "$CONFIG_PATH")" && pwd)/$(basename "$CONFIG_PATH")"

"$PNPM" install --frozen-lockfile
"$PNPM" build

xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

ESCAPED_NODE="$(printf '%s' "$NODE" | xml_escape)"
ESCAPED_ROOT="$(printf '%s' "$REPO_ROOT" | xml_escape)"
ESCAPED_CONFIG="$(printf '%s' "$CONFIG_PATH" | xml_escape)"
DAEMON_PATH="$(dirname "$NODE"):$(dirname "$PNPM"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
ESCAPED_PATH="$(printf '%s' "$DAEMON_PATH" | xml_escape)"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ESCAPED_NODE}</string>
    <string>${ESCAPED_ROOT}/dist/index.js</string>
    <string>--index-daemon</string>
  </array>
  <key>WorkingDirectory</key><string>${ESCAPED_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${ESCAPED_PATH}</string>
    <key>DOCS_RAG_CONFIG</key><string>${ESCAPED_CONFIG}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/${LABEL}.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/${LABEL}.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$UID/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl print "gui/$UID/${LABEL}" >/dev/null

echo "Documentation indexing daemon running: ${LABEL}"
echo "Logs: /tmp/${LABEL}.out.log /tmp/${LABEL}.err.log"

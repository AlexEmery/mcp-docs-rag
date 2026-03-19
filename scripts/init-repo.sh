#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: mcp-docs-rag-init <repo-path> <repo-key> [label]"
  echo ""
  echo "Sets up a repo to use mcp-docs-rag:"
  echo "  - Adds the repo to ~/.config/mcp-docs-rag/config.yaml"
  echo "  - Adds/merges docs-rag server into .mcp.json"
  echo "  - Creates .claude/commands/reindex-docs.md skill"
  echo "  - Appends docs-rag tool instructions to CLAUDE.md"
  echo ""
  echo "Arguments:"
  echo "  repo-path   Path to the repository root"
  echo "  repo-key    Short key for this repo (e.g. 'api', 'program')"
  echo "  label       Human-readable label (default: repo-key)"
  exit 1
}

[[ $# -lt 2 ]] && usage

repo_path="$(cd "$1" && pwd)"
repo_key="$2"
repo_label="${3:-$repo_key}"
config_file="${DOCS_RAG_CONFIG:-$HOME/.config/mcp-docs-rag/config.yaml}"

echo "Initializing mcp-docs-rag for repo: $repo_path (key: $repo_key)"

# --- config.yaml ---
if [[ -f "$config_file" ]] && grep -q "^  $repo_key:" "$config_file" 2>/dev/null; then
  echo "[skip] config.yaml already has repo '$repo_key'"
else
  echo "[update] Adding '$repo_key' to $config_file"
  mkdir -p "$(dirname "$config_file")"

  if [[ ! -f "$config_file" ]]; then
    cat > "$config_file" << EOF
cacheDir: ~/.cache/mcp-docs-rag
ollamaHost: http://localhost:11434
embeddingModel: nomic-embed-text
maxChunkChars: 3000

repos:
EOF
  fi

  # Find docs directories in the repo
  docs_paths=()
  for candidate in docs reference; do
    if [[ -d "$repo_path/$candidate" ]]; then
      docs_paths+=("$candidate")
    fi
  done

  if [[ ${#docs_paths[@]} -eq 0 ]]; then
    echo "[warn] No docs/ or reference/ directories found in $repo_path"
    echo "       Creating empty docs/ directory"
    mkdir -p "$repo_path/docs"
    docs_paths=("docs")
  fi

  # Use ~ shorthand for home directory paths
  short_path="${repo_path/#$HOME/~}"

  # Append repo entry
  {
    echo ""
    echo "  $repo_key:"
    echo "    label: $repo_label"
    echo "    repoPath: $short_path"
    echo "    docsPaths:"
    for dp in "${docs_paths[@]}"; do
      echo "      - $short_path/$dp"
    done
  } >> "$config_file"
fi

# --- .mcp.json ---
mcp_json="$repo_path/.mcp.json"
if [[ -f "$mcp_json" ]]; then
  if grep -q '"docs-rag"' "$mcp_json" 2>/dev/null; then
    echo "[skip] .mcp.json already has docs-rag server"
  else
    echo "[update] Adding docs-rag server to existing .mcp.json"
    node -e "
      const fs = require('fs');
      const config = JSON.parse(fs.readFileSync('$mcp_json', 'utf-8'));
      config.mcpServers = config.mcpServers || {};
      config.mcpServers['docs-rag'] = {
        command: 'mcp-docs-rag',
        env: { CURRENT_REPO: '$repo_key' }
      };
      fs.writeFileSync('$mcp_json', JSON.stringify(config, null, 2) + '\n');
    "
  fi
else
  echo "[create] .mcp.json"
  cat > "$mcp_json" << EOF
{
  "mcpServers": {
    "docs-rag": {
      "command": "mcp-docs-rag",
      "env": {
        "CURRENT_REPO": "$repo_key"
      }
    }
  }
}
EOF
fi

# --- .claude/commands/reindex-docs.md ---
skill_dir="$repo_path/.claude/commands"
skill_file="$skill_dir/reindex-docs.md"
if [[ -f "$skill_file" ]]; then
  echo "[skip] .claude/commands/reindex-docs.md already exists"
else
  echo "[create] .claude/commands/reindex-docs.md"
  mkdir -p "$skill_dir"
  cat > "$skill_file" << EOF
Reindex the documentation for the docs-rag MCP tools (search_docs, list_docs, read_doc).

## When to Use

Run this after editing any documentation files in \`docs/\` during a session so that the docs-rag tools return up-to-date content.

## Instructions

Run the reindex command:

\`\`\`bash
mcp-docs-rag --index-only --repo $repo_key
\`\`\`

The updated index will be available on the next tool call (server restarts automatically).
EOF
fi

# --- CLAUDE.md snippet ---
claude_md="$repo_path/CLAUDE.md"
script_dir="$(cd "$(dirname "$0")" && pwd)"
snippet_file="$script_dir/../templates/claude-md-snippet.md"

if [[ -f "$claude_md" ]] && grep -q 'list_docs' "$claude_md" 2>/dev/null; then
  echo "[skip] CLAUDE.md already references docs-rag tools"
elif [[ -f "$claude_md" ]] && grep -q 'search_docs' "$claude_md" 2>/dev/null; then
  echo "[warn] CLAUDE.md has old search_docs snippet — please replace manually with:"
  echo "       $snippet_file"
else
  echo "[append] Adding docs-rag instructions to CLAUDE.md"
  [[ -f "$claude_md" ]] || touch "$claude_md"
  printf '\n' >> "$claude_md"
  cat "$snippet_file" >> "$claude_md"
fi

echo ""
echo "Done! Run 'mcp-docs-rag --index-only --repo $repo_key' to index docs."

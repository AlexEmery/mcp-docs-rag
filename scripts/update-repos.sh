#!/usr/bin/env bash
set -euo pipefail

# Updates the reindex-docs skill and CLAUDE.md snippet across all configured repos.
# Reads repoPath from each repo entry in the config to locate repo roots.

script_dir="$(cd "$(dirname "$0")" && pwd)"
snippet_file="$script_dir/../templates/claude-md-snippet.md"
config_file="${DOCS_RAG_CONFIG:-$HOME/.config/mcp-docs-rag/config.yaml}"

if [[ ! -f "$config_file" ]]; then
  echo "Config not found: $config_file"
  exit 1
fi

if [[ ! -f "$snippet_file" ]]; then
  echo "Snippet template not found: $snippet_file"
  exit 1
fi

# Parse config with node to extract repo keys and paths
repos_json=$(node -e "
  const fs = require('fs');
  const yaml = require('$script_dir/../node_modules/yaml/dist/index.js');
  const config = yaml.parse(fs.readFileSync('$config_file', 'utf-8'));
  const repos = Object.entries(config.repos || {})
    .filter(([, v]) => v.repoPath)
    .map(([k, v]) => ({ key: k, repoPath: v.repoPath.replace(/^~/, process.env.HOME) }));
  console.log(JSON.stringify(repos));
")

count=$(echo "$repos_json" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).length))")

if [[ "$count" == "0" ]]; then
  echo "No repos with repoPath found in config. Add repoPath to your repo entries."
  exit 1
fi

echo "Updating $count repo(s)..."
echo ""

echo "$repos_json" | node -e "
  const repos = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf-8'));
  repos.forEach(r => console.log(r.key + '\t' + r.repoPath));
" | while IFS=$'\t' read -r repo_key repo_path; do
  echo "[$repo_key] $repo_path"

  # --- Update reindex-docs skill ---
  skill_dir="$repo_path/.claude/commands"
  skill_file="$skill_dir/reindex-docs.md"
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
  echo "  [updated] .claude/commands/reindex-docs.md"

  # --- Update CLAUDE.md snippet ---
  claude_md="$repo_path/CLAUDE.md"
  snippet_content=$(cat "$snippet_file")

  if [[ ! -f "$claude_md" ]]; then
    echo "$snippet_content" > "$claude_md"
    echo "  [created] CLAUDE.md"
  elif grep -q 'list_docs' "$claude_md" 2>/dev/null; then
    # Already has the new snippet — replace it
    # Remove old block from "## Documentation (MCP Tools)" to next ## or EOF
    node -e "
      const fs = require('fs');
      const md = fs.readFileSync('$claude_md', 'utf-8');
      const snippet = fs.readFileSync('$snippet_file', 'utf-8');
      const marker = '## Documentation (MCP Tools)';
      const idx = md.indexOf(marker);
      if (idx === -1) { process.exit(0); }
      const before = md.substring(0, idx);
      const after = md.substring(idx + marker.length);
      const nextSection = after.search(/\n## /);
      const rest = nextSection !== -1 ? after.substring(nextSection) : '';
      fs.writeFileSync('$claude_md', before.trimEnd() + '\n\n' + snippet.trim() + '\n' + rest);
    "
    echo "  [updated] CLAUDE.md"
  elif grep -q 'search_docs' "$claude_md" 2>/dev/null; then
    # Has old snippet — replace the old block
    node -e "
      const fs = require('fs');
      const md = fs.readFileSync('$claude_md', 'utf-8');
      const snippet = fs.readFileSync('$snippet_file', 'utf-8');
      const marker = '## Documentation Search (MCP Tool)';
      const idx = md.indexOf(marker);
      if (idx === -1) {
        // Old snippet with different heading — just append
        fs.writeFileSync('$claude_md', md.trimEnd() + '\n\n' + snippet.trim() + '\n');
        process.exit(0);
      }
      const before = md.substring(0, idx);
      const after = md.substring(idx + marker.length);
      const nextSection = after.search(/\n## /);
      const rest = nextSection !== -1 ? after.substring(nextSection) : '';
      fs.writeFileSync('$claude_md', before.trimEnd() + '\n\n' + snippet.trim() + '\n' + rest);
    "
    echo "  [updated] CLAUDE.md (replaced old search_docs snippet)"
  else
    printf '\n' >> "$claude_md"
    cat "$snippet_file" >> "$claude_md"
    echo "  [appended] CLAUDE.md"
  fi

  echo ""
done

echo "Done! All repos updated."

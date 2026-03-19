# mcp-docs-rag

Standalone MCP server for semantic search over documentation across multiple repositories. Chunks markdown docs, embeds them via Ollama, and exposes a `search_docs` tool for Claude Code agents.

## Setup

### 1. Install Ollama

Start the bundled Ollama container (or use a local install):

```bash
docker compose up -d
```

### 2. Install the tool

```bash
pnpm install && pnpm build && npm link
```

This makes `mcp-docs-rag` available globally.

### 3. Create config

```bash
mkdir -p ~/.config/mcp-docs-rag
cp templates/config.example.yaml ~/.config/mcp-docs-rag/config.yaml
```

Edit the config to add your repos:

```yaml
repos:
  api:
    label: Backend API
    docsPath: ~/projects/my-api/docs
  frontend:
    label: Frontend App
    docsPath: ~/projects/my-frontend/docs
```

### 4. Index docs

```bash
mcp-docs-rag --index-only          # Index all repos
mcp-docs-rag --index-only --repo api  # Index a single repo
```

### 5. Add to a project

Run the init script to set up a repo with `.mcp.json`, reindex skill, and CLAUDE.md snippet:

```bash
./scripts/init-repo.sh ~/projects/my-api api
```

Or manually add to the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "docs-rag": {
      "command": "mcp-docs-rag",
      "env": { "CURRENT_REPO": "api" }
    }
  }
}
```

## CLI

```bash
mcp-docs-rag                          # Index all repos + start MCP server
mcp-docs-rag --index-only             # Index all repos, then exit
mcp-docs-rag --index-only --repo api  # Index single repo, then exit
mcp-docs-rag --status                 # Show config and repo stats
```

## How it works

1. Reads markdown files from each repo's `docsPath`
2. Splits by H1/H2 headings, then recursively splits oversized chunks (H3 → paragraphs)
3. Embeds chunks via Ollama (`nomic-embed-text` by default)
4. Caches embeddings per-repo in `~/.cache/mcp-docs-rag/`
5. Exposes a `search_docs` MCP tool with cosine similarity search
6. The tool schema dynamically lists available repos and tells agents which repo they're in via `CURRENT_REPO`

## Previously

This tool was originally extracted from an internal monorepo to support indexing docs across multiple repositories from a single config.

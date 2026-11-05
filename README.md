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
mcp-docs-rag --init
```

Edit the config to add your repos:

```yaml
repos:
  api:
    label: Backend API
    docsPaths:
      - ~/projects/my-api/docs
  frontend:
    label: Frontend App
    docsPaths:
      - ~/projects/my-frontend/docs
```

### 4. Start the indexing daemon

```bash
./setup.sh
```

This installs and boots one per-user macOS `launchd` service, `com.mcp-docs-rag.indexer`. It starts at login, restarts if it exits, watches all configured documentation folders, and runs a full refresh every five minutes as a fallback. Logs are written to `/tmp/com.mcp-docs-rag.indexer.out.log` and `/tmp/com.mcp-docs-rag.indexer.err.log`.

Re-run `setup.sh` after moving the checkout or changing `DOCS_RAG_CONFIG`. To stop and disable the daemon:

```bash
launchctl bootout "gui/$UID/com.mcp-docs-rag.indexer"
```

### 5. Add to a project

Run the init script to set up a repo with `.mcp.json`, an optional reindex command, and CLAUDE.md snippet:

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

Each agent still starts its own stdio MCP process, but these processes never run indexing timers or documentation watchers. They load cached embeddings without contacting Ollama. Before each search, they check cache file timestamps and reload changed caches written by the daemon.

Manual indexing is still available to build the on-disk cache without starting the daemon:

```bash
mcp-docs-rag --index-only           # Index all repos
mcp-docs-rag --index-only --repo api # Index a single repo
```

## CLI

```bash
mcp-docs-rag --init                   # Create config from template
mcp-docs-rag                          # Start a cache-only MCP server
mcp-docs-rag --index-daemon           # Run the indexing daemon (normally managed by launchd)
mcp-docs-rag --index-only             # Index all repos, then exit
mcp-docs-rag --index-only --repo api  # Index single repo, then exit
mcp-docs-rag --status                 # Show config and repo stats
```

## How it works

1. `setup.sh` installs one persistent indexing daemon for the user
2. The daemon watches each repo's configured `docsPaths` and indexes changed repos
3. A full index runs every five minutes to recover from missed filesystem events
4. Markdown is split by H1/H2 headings, then oversized chunks are recursively split (H3 → paragraphs)
5. Chunks are embedded via Ollama (`nomic-embed-text` by default) and cached per repo in `~/.cache/mcp-docs-rag/`
6. Agent-started MCP processes load cached embeddings and expose `search_docs`, `list_docs`, and `read_doc`
7. Before searching, an MCP process reloads any cache files changed by the daemon
8. Search combines cosine similarity with BM25 keyword matching over text, titles, and paths; rare exact identifiers receive an additional boost
9. Tool schemas dynamically list available repos and identify the current repo via `CURRENT_REPO`

## Previously

This tool was originally extracted from an internal monorepo to support indexing docs across multiple repositories from a single config.

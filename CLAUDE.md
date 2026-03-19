# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP server that provides semantic search over markdown documentation across multiple repositories. It chunks markdown files, embeds them via Ollama (nomic-embed-text), caches embeddings per-repo, and exposes a `search_docs` tool over stdio transport.

## Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Compile TypeScript (tsc → dist/)
pnpm dev              # Watch mode compilation
pnpm start            # Run the compiled server
pnpm index            # Index all repos then exit
pnpm index:repo       # Index a single repo (append -- --repo <name>)

docker compose up -d  # Start Ollama container on port 11434
```

After building, `npm link` makes `mcp-docs-rag` available as a global CLI command.

## Architecture

**Entry flow:** `src/index.ts` parses CLI flags (`--index-only`, `--repo`, `--status`), loads config, initializes services, indexes docs, then either exits or starts the MCP server.

**Key modules:**
- `config.ts` — Loads YAML config from `~/.config/mcp-docs-rag/config.yaml` (override with `DOCS_RAG_CONFIG` env var). Validates with Zod. Each repo has a name, label, docsPaths array, and optional exclude list.
- `document-store.ts` — Reads markdown files, chunks them by H1/H2 headings with recursive splitting (H3 → paragraphs) when chunks exceed `maxChunkChars`. Handles `<!-- @shared -->` tag for cross-repo documents. Performs cosine similarity search with a 0.3 threshold.
- `embeddings.ts` — Wraps Ollama client. Maintains per-repo embedding caches (SHA-256 keyed) in `~/.cache/mcp-docs-rag/`. Only saves cache when dirty (new embeddings generated).
- `server.ts` — Sets up MCP server with three tools: `search_docs` (semantic search over chunks), `list_docs` (browse available doc files per repo), and `read_doc` (load full file contents). Tool schemas dynamically include available repo names and `CURRENT_REPO` context.
- `utils.ts` — Cosine similarity function.

**Data flow:** Config → DocumentStore loads markdown → chunks by headings → EmbeddingsService embeds via Ollama (with cache) → DocumentStore.search() does cosine similarity → MCP server returns formatted results.

## Configuration

Config lives at `~/.config/mcp-docs-rag/config.yaml`. The `repos` field is a record where keys become repo filter values in the search tool. Each repo needs `label` and `docsPaths`; `exclude` is optional.

## Init Script

`scripts/init-repo.sh <repo-path> <repo-key> [label]` sets up a target repo: adds it to the global config, creates `.mcp.json`, adds a `/reindex-docs` Claude command, and appends `search_docs` instructions to that repo's CLAUDE.md.

## Tech Stack

TypeScript (ES2022, NodeNext modules), MCP SDK (`@modelcontextprotocol/sdk`), Ollama client, Zod for config validation, YAML parser. No test framework configured.

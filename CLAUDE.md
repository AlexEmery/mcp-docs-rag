# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP server that provides semantic search over markdown documentation across multiple repositories. It chunks markdown files, embeds them via Ollama (nomic-embed-text), caches embeddings per-repo, and exposes a `search_docs` tool over stdio transport.

## Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Compile TypeScript (tsc → dist/)
pnpm dev              # Watch mode compilation
pnpm start            # Run the compiled cache-only MCP server
pnpm index            # Index all repos then exit
pnpm index:repo       # Index a single repo (append -- --repo <name>)
pnpm test             # Compile, then run dist/**/*.test.js with node --test
./setup.sh            # Install and boot the single per-user indexing daemon

docker compose up -d  # Start Ollama container on port 11434
```

After building, `npm link` makes `mcp-docs-rag` available as a global CLI command.

## Architecture

**Self-update:** `src/index.ts` is only a launcher. Before loading the program (`src/main.ts`) it runs `pnpm install --frozen-lockfile` if `package.json`/`pnpm-lock.yaml` are newer than `node_modules/.modules.yaml`, and `tsc` if anything in `src/`, `tsconfig.json` or `package.json` is newer than `dist/main.js` (`src/self-build.ts`). So a `git pull` takes effect on the next process start; one process builds under `.build.lock` while the others wait. Running MCP processes and the indexing daemon keep their existing code until restarted. The launcher itself only updates after it has run once, so a checkout from before it existed needs one manual `pnpm build`.

**Indexing daemon:** `setup.sh` builds the package and installs `~/Library/LaunchAgents/com.mcp-docs-rag.indexer.plist`, then boots `dist/index.js --index-daemon` through `launchd`. `RunAtLoad` starts it at login and `KeepAlive` restarts it if it exits. This is the only process with documentation watchers or indexing timers. Logs go to `/tmp/com.mcp-docs-rag.indexer.{out,err}.log`.

**Automatic indexing** (`src/auto-index.ts`). The daemon gives each configured docs folder a recursive filesystem watcher. Changes are debounced and queue only the affected repo. A full pass runs at daemon startup and every five minutes as a fallback. Watcher or indexing failures are logged without stopping the daemon, and later events or the periodic pass retry indexing.

**MCP entry flow:** `src/main.ts` parses CLI flags (`--index-daemon`, `--index-only`, `--repo`, `--status`) and loads config. `--index-only` queues one index pass and exits. Default startup only reads the existing cache, without contacting Ollama or taking the index lock, then starts the stdio MCP server. Each agent may start its own MCP process, but none indexes documentation. Before `search_docs`, the process stats its selected cache files and reloads them if their timestamps or sizes changed, so daemon updates become visible on the next search without restarting MCP.

**One index pass at a time** (`src/index-queue.ts`). Every process that wants an index, `--index-only` or the indexing daemon, writes a request into `<cacheDir>/index-queue/`. Whichever process takes `index-queue/index.lock` runs ONE pass over the union of every request queued when it starts (`all` absorbs named repos), marks each request done, and frees the lock; the others wait and exit when theirs is marked done. A request that arrives during a pass waits for the next one. A lock or request left by a process that died is dropped by the next run. Cache-only MCP reads do not repair partial files, so they cannot interfere with an active writer.

**Key modules:**
- `auto-index.ts` — The daemon's docs watchers, debounce logic, startup pass, and periodic full pass.
- `config.ts` — Loads YAML config from `~/.config/mcp-docs-rag/config.yaml` (override with `DOCS_RAG_CONFIG` env var). Validates with Zod. Each repo has a name, label, docsPaths array, and optional exclude list.
- `document-store.ts` — Reads markdown files, chunks them by H1/H2 headings with recursive splitting (H3 → paragraphs) when chunks exceed `maxChunkChars`. Handles `<!-- @shared -->` tag for cross-repo documents. Loads chunks with cached embeddings and replaces repo chunks when caches change. Search combines cosine similarity with BM25 over text, titles, and paths using reciprocal-rank fusion. Rare whole query terms that exactly match a path/title, or compound terms such as config keys that exactly match chunk text, receive an additional boost.
- `embeddings.ts` — Wraps Ollama client. Maintains per-repo embedding caches in `~/.cache/mcp-docs-rag/<repo>.embeddings.bin`: binary records of a SHA-256 of the chunk text plus the float32 vector. Each new embedding is appended as it is made, so a crash loses nothing already embedded. After a repo's full pass the file is rewritten without embeddings for text no chunk has any more (skipped when the repo produced no chunks); the end-of-run summary shows per repo how many were kept and deleted. An old `<repo>.embeddings.json` is converted on first writable load and deleted.
- `server.ts` — Sets up MCP server with three tools: `search_docs` (hybrid keyword and semantic search over chunks), `list_docs` (browse available doc files per repo), and `read_doc` (load full file contents). Runs the cache refresh callback before searches. Tool schemas dynamically include available repo names and `CURRENT_REPO` context.
- `utils.ts` — Cosine similarity function.

**Data flow:** One daemon indexes docs → Ollama embeddings are cached per repo → each MCP process loads cached chunks → cache changes are reloaded before search → DocumentStore.search() combines keyword and cosine rankings → MCP server returns formatted results.

## Configuration

Config lives at `~/.config/mcp-docs-rag/config.yaml`. The `repos` field is a record where keys become repo filter values in the search tool. Each repo needs `label` and `docsPaths`; `exclude` is optional. `setup.sh` resolves and writes `DOCS_RAG_CONFIG` into the daemon's launchd environment; re-run it if that path changes.

## Init Script

`scripts/init-repo.sh <repo-path> <repo-key> [label]` sets up a target repo: adds it to the global config, creates `.mcp.json`, adds an optional `/reindex-docs` Claude command, and appends `search_docs` instructions to that repo's CLAUDE.md. Agents are told that docs edits are indexed automatically and do not require manual reindexing.

## Tech Stack

TypeScript (ES2022, NodeNext modules), MCP SDK (`@modelcontextprotocol/sdk`), Ollama client, Zod for config validation, YAML parser. Tests use node's built-in runner (`node:test`).

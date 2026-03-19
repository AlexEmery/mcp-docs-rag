## Documentation (MCP Tools)

Three tools are available for accessing project documentation:

- `search_docs("query")` — semantic search across doc chunks, best for quick lookups
- `list_docs()` — browse available doc files (optionally filter by repo)
- `read_doc(repo, path)` — load a full doc file for deep context

**Rules:**
1. ALWAYS use `search_docs` before implementing anything
2. For complex tasks, use `list_docs` then `read_doc` to load full specs/guidelines
3. Use `search_docs` after context compaction to restore context
4. If `search_docs` returns no results, tell the user so docs can be improved
5. Run `/reindex-docs` after editing any files in `docs/`

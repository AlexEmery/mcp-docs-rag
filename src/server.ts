import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DocumentStore } from "./document-store.js";
import type { RepoConfig } from "./config.js";

function buildListDocsTool(repos: RepoConfig[], currentRepo?: string): Tool {
  const repoNames = repos.map((r) => r.name);
  const currentRepoLine = currentRepo
    ? `\nYour current repo: "${currentRepo}"\n`
    : "";

  return {
    name: "list_docs",
    description: `List available documentation files across repos. Shows top-level files and collapsed subdirectories with file counts.
${currentRepoLine}
Use this to discover what documentation exists before using read_doc to load full files.
Pass a path to expand a subdirectory (e.g. path: "code-review/rust/").`,
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          enum: repoNames,
          description: "Filter to a specific repo. Omit to list all repos.",
        },
        path: {
          type: "string",
          description: "Subdirectory to expand (e.g. \"code-review/rust/\"). Omit to show top-level overview.",
        },
      },
    },
  };
}

function buildReadDocTool(repos: RepoConfig[], currentRepo?: string): Tool {
  const repoNames = repos.map((r) => r.name);
  const currentRepoLine = currentRepo
    ? `\nYour current repo: "${currentRepo}"\n`
    : "";

  return {
    name: "read_doc",
    description: `Read the full content of a documentation file. Returns the complete markdown file.
${currentRepoLine}
Use this when you need deep context on a topic — e.g., starting a new task, understanding a full specification, or loading comprehensive guidelines.
Use list_docs first to discover available files, then read_doc to load the ones you need.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          enum: repoNames,
          description: "The repo containing the file.",
        },
        path: {
          type: "string",
          description: "Relative path to the doc file (from list_docs output).",
        },
      },
      required: ["repo", "path"],
    },
  };
}

function buildSearchDocsTool(repos: RepoConfig[], currentRepo?: string): Tool {
  const repoNames = repos.map((r) => r.name);
  const repoList = repos.map((r) => `- "${r.name}" - ${r.label}`).join("\n");

  const currentRepoLine = currentRepo
    ? `\nYour current repo: "${currentRepo}" (${repos.find((r) => r.name === currentRepo)?.label || currentRepo})\n`
    : "";

  const currentRepoTip = currentRepo
    ? `\nTip: Use repo: "${currentRepo}" to search only your project's docs.`
    : "";

  return {
    name: "search_docs",
    description: `Semantic search over indexed documentation across multiple projects.
${currentRepoLine}
AVAILABLE REPOS:
${repoList}

SHARED KNOWLEDGE (no filter needed):
- Documents tagged with <!-- @shared --> appear in all repo searches
- Protocol concepts, cross-repo conventions, shared business logic

WHEN TO USE 'repo' FILTER:
- Use repo filter for implementation-specific patterns (e.g., testing, code style)
- OMIT repo for shared concepts, protocol docs, cross-project knowledge

USE THIS TOOL CONSTANTLY:
- Before implementing anything
- After context compaction (to restore context)
- Whenever uncertain about a pattern
${currentRepoTip}
IF NO RESULTS: Tell the user documentation may be missing so they can improve coverage.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query for documentation",
        },
        top_k: {
          type: "number",
          description: "Number of results to return (default: 5)",
          default: 5,
        },
        repo: {
          type: "string",
          enum: repoNames,
          description: `Filter to specific repo. Omit to search all repos.`,
        },
      },
      required: ["query"],
    },
  };
}

export async function startServer(
  documentStore: DocumentStore,
  repos: RepoConfig[],
  currentRepo?: string
): Promise<void> {
  const server = new Server(
    {
      name: "docs-rag",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const searchDocsTool = buildSearchDocsTool(repos, currentRepo);
  const listDocsTool = buildListDocsTool(repos, currentRepo);
  const readDocTool = buildReadDocTool(repos, currentRepo);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [searchDocsTool, listDocsTool, readDocTool],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "search_docs") {
      const args = request.params.arguments as {
        query: string;
        top_k?: number;
        repo?: string;
      };

      try {
        const searchResponse = await documentStore.search(
          args.query,
          args.top_k || 5,
          0.3,
          args.repo
        );

        let responseText = "";
        const repoContext = args.repo ? ` in repo "${args.repo}"` : "";

        if (searchResponse.results.length === 0) {
          responseText = `No documentation found for: "${args.query}"${repoContext}\n\n`;
          responseText += searchResponse.suggestion || "";
        } else {
          responseText = `Found ${searchResponse.results.length} relevant documentation sections${repoContext}:\n\n`;

          for (const result of searchResponse.results) {
            responseText += `## ${result.section}\n`;
            responseText += `File: [${result.repo}] ${result.file} (similarity: ${result.similarity})\n\n`;
            responseText += result.content + "\n\n";
            responseText += "---\n\n";
          }

          if (searchResponse.missing && searchResponse.suggestion) {
            responseText += `\nNote: ${searchResponse.suggestion}`;
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: responseText,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching documentation: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    if (request.params.name === "list_docs") {
      const args = request.params.arguments as { repo?: string; path?: string };

      try {
        const entries = await documentStore.listFiles(args.repo, args.path);

        if (entries.length === 0) {
          const repoContext = args.repo ? ` in repo "${args.repo}"` : "";
          const pathContext = args.path ? ` under "${args.path}"` : "";
          return {
            content: [{ type: "text" as const, text: `No documentation files found${repoContext}${pathContext}.` }],
          };
        }

        const grouped: Record<string, typeof entries> = {};
        for (const entry of entries) {
          const key = `[${entry.repo}] ${entry.label}`;
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(entry);
        }

        let text = "";
        for (const [repoLabel, items] of Object.entries(grouped)) {
          const totalFiles = items.reduce((sum, e) => sum + (e.fileCount || 1), 0);
          text += `### ${repoLabel} (${totalFiles} files)\n`;
          for (const item of items) {
            if (item.fileCount) {
              text += `- ${item.file} (${item.fileCount} files)\n`;
            } else {
              text += `- ${item.file}\n`;
            }
          }
          text += "\n";
        }

        text += `Use list_docs with path to expand a directory, or read_doc to load a file.`;

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error listing docs: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }

    if (request.params.name === "read_doc") {
      const args = request.params.arguments as { repo: string; path: string };

      if (!args.repo || !args.path) {
        return {
          content: [{ type: "text" as const, text: "Both 'repo' and 'path' are required." }],
          isError: true,
        };
      }

      try {
        const result = await documentStore.readFile(args.repo, args.path);

        if (!result) {
          return {
            content: [{ type: "text" as const, text: `File not found: [${args.repo}] ${args.path}\n\nUse list_docs to see available files.` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `# [${result.repo}] ${result.file}\n\n${result.content}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error reading doc: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Unknown tool: ${request.params.name}`,
        },
      ],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP docs-rag server running");
}

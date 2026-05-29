import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const defaultConfigPath = path.join(os.homedir(), ".config", "mcp-docs-rag", "config.yaml");

const repoSchema = z.object({
  label: z.string(),
  repoPath: z.string().optional(),
  docsPaths: z.array(z.string()),
  exclude: z.array(z.string()).optional(),
});

const configSchema = z.object({
  cacheDir: z.string().default("~/.cache/mcp-docs-rag"),
  ollamaHost: z.string().default("http://localhost:11434"),
  embeddingModel: z.string().default("nomic-embed-text"),
  maxChunkChars: z.number().default(3000),
  repos: z.record(z.string(), repoSchema).default({}),
});

export type RepoConfig = z.infer<typeof repoSchema> & { name: string };
export type Config = Omit<z.infer<typeof configSchema>, "repos"> & { repos: RepoConfig[] };

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export async function loadConfig(): Promise<Config> {
  const configPath = process.env.DOCS_RAG_CONFIG || defaultConfigPath;
  const expandedPath = expandTilde(configPath);

  let raw: string;
  try {
    raw = await fs.readFile(expandedPath, "utf-8");
  } catch {
    throw new Error(
      `Config file not found at ${expandedPath}. Create it or set DOCS_RAG_CONFIG env var.\n` +
        `See templates/config.example.yaml for the expected format.`
    );
  }

  const parsed = parseYaml(raw);
  const validated = configSchema.parse(parsed);

  const repos: RepoConfig[] = Object.entries(validated.repos).map(([name, repo]) => ({
    name,
    label: repo.label,
    repoPath: repo.repoPath ? expandTilde(repo.repoPath) : undefined,
    docsPaths: repo.docsPaths.map(expandTilde),
    exclude: repo.exclude,
  }));

  return {
    cacheDir: expandTilde(validated.cacheDir),
    ollamaHost: validated.ollamaHost,
    embeddingModel: validated.embeddingModel,
    maxChunkChars: validated.maxChunkChars,
    repos,
  };
}

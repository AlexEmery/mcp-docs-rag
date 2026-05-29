#!/usr/bin/env node

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { loadConfig } from "./config.js";
import { DocumentStore } from "./document-store.js";
import { EmbeddingsService } from "./embeddings.js";
import { startServer } from "./server.js";

function parseArgs(): { indexOnly: boolean; repo?: string; status: boolean; init: boolean } {
  const args = process.argv.slice(2);
  return {
    indexOnly: args.includes("--index-only"),
    repo: args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined,
    status: args.includes("--status"),
    init: args.includes("--init"),
  };
}

async function runInit(): Promise<void> {
  const configDir = path.join(os.homedir(), ".config", "mcp-docs-rag");
  const configPath = path.join(configDir, "config.yaml");

  // Check if config already exists
  try {
    await fs.access(configPath);
    console.log(`Config already exists at ${configPath}`);
    return;
  } catch {
    // Doesn't exist, create it
  }

  await fs.mkdir(configDir, { recursive: true });

  // Copy the example template — resolve from the package root (two levels up from dist/index.js)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const templatePath = path.join(__dirname, "..", "templates", "config.example.yaml");
  await fs.copyFile(templatePath, configPath);

  console.log(`Created config at ${configPath}`);
  console.log(`Edit it to add your repos, then run: mcp-docs-rag --index-only`);
}

async function main(): Promise<void> {
  const flags = parseArgs();

  if (flags.init) {
    await runInit();
    return;
  }

  const config = await loadConfig();
  const currentRepo = process.env.CURRENT_REPO;

  if (flags.status) {
    console.log("Config loaded successfully\n");
    console.log(`Cache dir: ${config.cacheDir}`);
    console.log(`Ollama host: ${config.ollamaHost}`);
    console.log(`Embedding model: ${config.embeddingModel}`);
    console.log(`Max chunk chars: ${config.maxChunkChars}`);
    console.log(`\nRepos (${config.repos.length}):`);
    for (const repo of config.repos) {
      console.log(`  [${repo.name}] ${repo.label}: ${repo.docsPaths.join(", ")}`);
    }
    if (currentRepo) {
      console.log(`\nCurrent repo context: ${currentRepo}`);
    }
    process.exit(0);
  }

  if (config.repos.length === 0) {
    console.error("No repos configured. Edit ~/.config/mcp-docs-rag/config.yaml to add repos.");
    if (flags.indexOnly) {
      process.exit(0);
    }
    // Still start the server with no docs — tools will return empty results
  }

  console.error("Documentation sources:");
  for (const repo of config.repos) {
    console.error(`  [${repo.name}] ${repo.label}: ${repo.docsPaths.join(", ")}`);
  }
  console.error(`Cache directory: ${config.cacheDir}`);

  const embeddingsService = new EmbeddingsService(config.cacheDir, config.ollamaHost, config.embeddingModel);
  const documentStore = new DocumentStore(config.repos, embeddingsService, config.maxChunkChars);

  await embeddingsService.ensureModel();

  const reposToIndex = flags.repo
    ? config.repos.filter((r) => r.name === flags.repo)
    : config.repos;

  if (flags.repo && reposToIndex.length === 0) {
    console.error(`Unknown repo: "${flags.repo}". Available: ${config.repos.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }

  for (const repo of reposToIndex) {
    await embeddingsService.loadCache(repo.name);
  }

  await documentStore.loadDocumentation(flags.repo);
  await documentStore.indexChunks(flags.repo);

  for (const repo of reposToIndex) {
    await embeddingsService.saveCache(repo.name);
  }

  const counts = documentStore.getRepoChunkCounts();
  console.error(`Indexed ${documentStore.getChunkCount()} total chunks:`);
  for (const [repo, count] of Object.entries(counts)) {
    console.error(`  [${repo}] ${count} chunks`);
  }

  if (flags.indexOnly) {
    console.error("Index-only mode: exiting after indexing");
    process.exit(0);
  }

  if (!flags.repo) {
    for (const repo of config.repos) {
      if (!reposToIndex.find((r) => r.name === repo.name)) {
        await embeddingsService.loadCache(repo.name);
      }
    }
  }

  await startServer(documentStore, config.repos, currentRepo);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

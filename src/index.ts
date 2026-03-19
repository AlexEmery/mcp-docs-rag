#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { DocumentStore } from "./document-store.js";
import { EmbeddingsService } from "./embeddings.js";
import { startServer } from "./server.js";

function parseArgs(): { indexOnly: boolean; repo?: string; status: boolean } {
  const args = process.argv.slice(2);
  return {
    indexOnly: args.includes("--index-only"),
    repo: args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined,
    status: args.includes("--status"),
  };
}

async function main(): Promise<void> {
  const flags = parseArgs();
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

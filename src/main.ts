import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { loadConfig } from "./config.js";
import { DocumentStore } from "./document-store.js";
import { EmbeddingsService } from "./embeddings.js";
import { startServer } from "./server.js";
import { indexQueued, type RepoSet } from "./index-queue.js";
import { startAutoIndexing } from "./auto-index.js";

function parseArgs(): { indexOnly: boolean; indexDaemon: boolean; repo?: string; status: boolean; init: boolean } {
  const args = process.argv.slice(2);
  return {
    indexOnly: args.includes("--index-only"),
    indexDaemon: args.includes("--index-daemon"),
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
  console.log("Edit it to add your repos, then start the indexing daemon with the repository's setup.sh.");
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
    if (flags.indexOnly || flags.indexDaemon) {
      process.exit(flags.indexDaemon ? 1 : 0);
    }
    // Still start the server with no docs — tools will return empty results
  }

  console.error("Documentation sources:");
  for (const repo of config.repos) {
    console.error(`  [${repo.name}] ${repo.label}: ${repo.docsPaths.join(", ")}`);
  }
  console.error(`Cache directory: ${config.cacheDir}`);

  if (flags.repo && !config.repos.some((r) => r.name === flags.repo)) {
    console.error(`Unknown repo: "${flags.repo}". Available: ${config.repos.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }

  const namesFor = (repos: RepoSet): string[] => repos === "all" ? config.repos.map((r) => r.name) : repos;

  async function buildStore(repos: RepoSet): Promise<DocumentStore> {
    const names = namesFor(repos);
    const embeddingsService = new EmbeddingsService(config.cacheDir, config.ollamaHost, config.embeddingModel);
    const documentStore = new DocumentStore(config.repos, embeddingsService, config.maxChunkChars);
    if (names.length > 0) await embeddingsService.ensureModel();
    const cacheResults = new Map<string, string>();
    for (const name of names) {
      await embeddingsService.loadCache(name);
      await documentStore.loadDocumentation(name);
      await documentStore.indexChunks(name);
      cacheResults.set(name, await embeddingsService.saveCache(name));
    }
    const counts = documentStore.getRepoChunkCounts();
    console.error(`Indexed ${documentStore.getChunkCount()} total chunks:`);
    for (const name of names) {
      console.error(`  [${name}] ${counts[name] ?? 0} chunks; ${cacheResults.get(name)}`);
    }
    return documentStore;
  }

  async function loadCachedStore(repos: RepoSet): Promise<DocumentStore> {
    const embeddingsService = new EmbeddingsService(config.cacheDir, config.ollamaHost, config.embeddingModel);
    const documentStore = new DocumentStore(config.repos, embeddingsService, config.maxChunkChars);
    for (const name of namesFor(repos)) {
      await embeddingsService.loadCache(name, { readOnly: true });
      await documentStore.loadDocumentation(name);
    }
    documentStore.loadCachedChunks();
    return documentStore;
  }

  const wanted: RepoSet = flags.repo ? [flags.repo] : "all";
  if (flags.indexOnly) {
    await indexQueued(config.cacheDir, wanted, async (repos) => {
      await buildStore(repos);
    });
    console.error("Index-only mode: exiting after indexing");
    process.exit(0);
  }

  if (flags.indexDaemon) {
    const daemonRepos = config.repos.filter((repo) => namesFor(wanted).includes(repo.name));
    const autoIndexing = startAutoIndexing(daemonRepos, async (repos) => {
      await indexQueued(config.cacheDir, repos, async (batch) => {
        await buildStore(batch);
      });
      console.error("Automatic indexing complete");
    });
    console.error("Documentation indexing daemon running");
    process.once("SIGTERM", autoIndexing.close);
    process.once("SIGINT", autoIndexing.close);
    return;
  }

  async function cacheVersion(): Promise<string> {
    const versions = await Promise.all(namesFor(wanted).map(async (name) => {
      const stat = await fs.stat(path.join(config.cacheDir, `${name}.embeddings.bin`)).catch(() => null);
      return `${name}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`;
    }));
    return versions.join("|");
  }

  let loadedCacheVersion = await cacheVersion();
  const documentStore = await loadCachedStore(wanted);
  let refreshing: Promise<void> | undefined;
  async function refreshCache(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const version = await cacheVersion();
      if (version === loadedCacheVersion) return;
      const updated = await loadCachedStore(wanted);
      documentStore.replaceRepos(namesFor(wanted), updated);
      loadedCacheVersion = version;
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  await startServer(documentStore, config.repos, currentRepo, refreshCache);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

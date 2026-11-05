import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DocumentStore } from "./document-store.js";
import { EmbeddingsService } from "./embeddings.js";
import type { RepoConfig } from "./config.js";

const semanticQuery = "s71 strategy documentation config entry gate code";

class FakeEmbeddings extends EmbeddingsService {
  constructor(cacheDir: string) {
    super(cacheDir, "http://unused", "fake");
  }

  protected override async generate(text: string): Promise<number[]> {
    if (text === semanticQuery) return [1, 0];
    if (text.includes("qualifying P1") || text.includes("NHL comeback")) return [0, 1];
    return [1, 0];
  }
}

async function fixture(): Promise<DocumentStore> {
  const docsPath = await fs.mkdtemp(path.join(os.tmpdir(), "docs-rag-search-"));
  const files = new Map([
    ["strategies/s71-f1-pole-after-qualifying/BRIEF.md", "# Entry rule\n\nBuy the qualifying P1 driver after qualifying ends and hold the position to settlement."],
    ["strategies/s38-basketball-pregame-favorite/BRIEF.md", "# Entry rule\n\nUse generic entry gates with configuration code and strategy documentation for every market."],
    ["strategies/_TEMPLATE/BRIEF.md", "# Entry rule\n\nGeneric strategy documentation explains configuration code and entry gates for a new strategy."],
    ["strategies/s65.1-nhl-comeback-model/BRIEF.md", "# Entry rule\n\nThe NHL comeback model enters after the price moves and holds until the game resolves."],
    ["engine/CONFIGS.md", "# Configuration\n\nThe f1_qualifying_rule key configures the qualifying entry gate used by the trader."],
  ]);
  for (const [file, content] of files) {
    await fs.mkdir(path.dirname(path.join(docsPath, file)), { recursive: true });
    await fs.writeFile(path.join(docsPath, file), content);
  }
  const repo: RepoConfig = { name: "repo", label: "Repo", docsPaths: [docsPath] };
  const store = new DocumentStore([repo], new FakeEmbeddings(docsPath), 3000);
  await store.loadDocumentation();
  await store.indexChunks();
  return store;
}

test("an identifier in the filename outranks generic semantic matches", async () => {
  const store = await fixture();
  const response = await store.search(semanticQuery, 8, 0.3, "repo");
  assert.equal(response.results[0]?.file, "strategies/s71-f1-pole-after-qualifying/BRIEF.md");
  assert.equal(response.missing, false);
});

test("a dotted strategy identifier is preserved as a search term", async () => {
  const store = await fixture();
  const response = await store.search("s65.1 entry gate", 8, 0.3, "repo");
  assert.equal(response.results[0]?.file, "strategies/s65.1-nhl-comeback-model/BRIEF.md");
});

test("a config key finds the document containing that exact key", async () => {
  const store = await fixture();
  const response = await store.search("f1_qualifying_rule", 8, 0.3, "repo");
  assert.equal(response.results[0]?.file, "engine/CONFIGS.md");
});

test("natural-language semantic matches remain searchable", async () => {
  const store = await fixture();
  const response = await store.search("which qualifying driver should the strategy buy", 8, 0.3, "repo");
  assert.ok(response.results.some((result) => result.file === "strategies/s71-f1-pole-after-qualifying/BRIEF.md"));
});

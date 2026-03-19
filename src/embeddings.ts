import { Ollama } from "ollama";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";

type EmbeddingsCache = Record<string, number[]>;

export class EmbeddingsService {
  private ollama: Ollama;
  private caches: Map<string, EmbeddingsCache> = new Map();
  private cacheDir: string;
  private embeddingModel: string;
  private dirtyRepos: Set<string> = new Set();

  constructor(cacheDir: string, ollamaHost: string, embeddingModel: string) {
    this.ollama = new Ollama({ host: ollamaHost });
    this.cacheDir = cacheDir;
    this.embeddingModel = embeddingModel;
    console.error(`Using Ollama at: ${ollamaHost}`);
    console.error(`Embedding model: ${embeddingModel}`);
  }

  async ensureModel(): Promise<void> {
    try {
      console.error(`Checking for model: ${this.embeddingModel}`);
      const models = await this.ollama.list();
      const hasModel = models.models.some((m) => m.name.startsWith(this.embeddingModel));

      if (!hasModel) {
        console.error(`Pulling model: ${this.embeddingModel} (this may take a few minutes)...`);
        await this.ollama.pull({ model: this.embeddingModel });
        console.error(`Model ${this.embeddingModel} pulled successfully`);
      } else {
        console.error(`Model ${this.embeddingModel} already available`);
      }
    } catch (error) {
      console.error(`Error checking/pulling model: ${error}`);
      throw error;
    }
  }

  private getCachePath(repoName: string): string {
    return path.join(this.cacheDir, `${repoName}.embeddings.json`);
  }

  async loadCache(repoName: string): Promise<void> {
    try {
      const data = await fs.readFile(this.getCachePath(repoName), "utf-8");
      const cache = JSON.parse(data) as EmbeddingsCache;
      this.caches.set(repoName, cache);
      console.error(`Loaded ${Object.keys(cache).length} cached embeddings for [${repoName}]`);
    } catch {
      console.error(`No existing cache for [${repoName}], starting fresh`);
      this.caches.set(repoName, {});
    }
  }

  async saveCache(repoName: string): Promise<void> {
    if (!this.dirtyRepos.has(repoName)) {
      console.error(`Cache for [${repoName}] unchanged, skipping save`);
      return;
    }
    const cache = this.caches.get(repoName);
    if (!cache) return;

    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.writeFile(this.getCachePath(repoName), JSON.stringify(cache));
    console.error(`Saved ${Object.keys(cache).length} embeddings for [${repoName}]`);
    this.dirtyRepos.delete(repoName);
  }

  private getCacheKey(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
  }

  private getCache(repoName: string): EmbeddingsCache {
    let cache = this.caches.get(repoName);
    if (!cache) {
      cache = {};
      this.caches.set(repoName, cache);
    }
    return cache;
  }

  async embed(text: string, repoName: string): Promise<number[]> {
    const cache = this.getCache(repoName);
    const cacheKey = this.getCacheKey(text);

    if (cache[cacheKey]) {
      return cache[cacheKey];
    }

    try {
      const response = await this.ollama.embeddings({
        model: this.embeddingModel,
        prompt: text,
      });

      const embedding = response.embedding;
      cache[cacheKey] = embedding;
      this.dirtyRepos.add(repoName);
      return embedding;
    } catch (error) {
      console.error(`Error generating embedding: ${error}`);
      throw error;
    }
  }

  async embedQuery(text: string): Promise<number[]> {
    try {
      const response = await this.ollama.embeddings({
        model: this.embeddingModel,
        prompt: text,
      });
      return response.embedding;
    } catch (error) {
      console.error(`Error generating query embedding: ${error}`);
      throw error;
    }
  }
}

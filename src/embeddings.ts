import { Ollama } from "ollama";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";

// Cache file layout: a header (MAGIC, then the vector length as uint32 LE),
// then fixed-size records of a 32-byte SHA-256 of the chunk text followed by
// the vector as float32 LE. New embeddings are appended as they are made, so a
// crash keeps everything embedded up to that point; the file is rewritten
// (dropping text that no longer exists) only after a repo's full pass.
const MAGIC = Buffer.from("DRAGEMB1");
const HEADER_BYTES = MAGIC.length + 4;
const KEY_BYTES = 32;

type EmbeddingsCache = Map<string, Float32Array>;

interface RepoCache {
  entries: EmbeddingsCache;
  // Keys asked for since the cache was loaded; everything else is stale once the pass ends.
  used: Set<string>;
  // Vector length in the file on disk; null when there is no file yet.
  dim: number | null;
}

export class EmbeddingsService {
  private ollama: Ollama;
  private caches: Map<string, RepoCache> = new Map();
  private cacheDir: string;
  private embeddingModel: string;

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
    return path.join(this.cacheDir, `${repoName}.embeddings.bin`);
  }

  // The JSON cache written by earlier versions; converted on first load.
  private getLegacyCachePath(repoName: string): string {
    return path.join(this.cacheDir, `${repoName}.embeddings.json`);
  }

  async loadCache(repoName: string): Promise<void> {
    const repo: RepoCache = { entries: new Map(), used: new Set(), dim: null };
    this.caches.set(repoName, repo);

    let data: Buffer | null = null;
    try {
      data = await fs.readFile(this.getCachePath(repoName));
    } catch {
      // No binary cache yet.
    }

    if (data) {
      await this.readRecords(repoName, repo, data);
    } else if (!(await this.convertLegacyCache(repoName, repo))) {
      console.error(`No existing cache for [${repoName}], starting fresh`);
      return;
    }
    console.error(`Loaded ${repo.entries.size} cached embeddings for [${repoName}]`);
  }

  private async readRecords(repoName: string, repo: RepoCache, data: Buffer): Promise<void> {
    if (data.length < HEADER_BYTES || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
      console.error(`Cache file for [${repoName}] is not a cache file, starting fresh`);
      await fs.rm(this.getCachePath(repoName), { force: true });
      return;
    }
    const dim = data.readUInt32LE(MAGIC.length);
    const recordBytes = KEY_BYTES + dim * 4;
    const count = Math.floor((data.length - HEADER_BYTES) / recordBytes);
    for (let i = 0; i < count; i++) {
      const offset = HEADER_BYTES + i * recordBytes;
      const key = data.toString("hex", offset, offset + KEY_BYTES);
      const vec = new Float32Array(dim);
      for (let j = 0; j < dim; j++) {
        vec[j] = data.readFloatLE(offset + KEY_BYTES + j * 4);
      }
      repo.entries.set(key, vec);
    }
    repo.dim = dim;

    // A crash mid-append leaves part of a record at the end; cut it off so the
    // next append starts on a record boundary.
    const wholeBytes = HEADER_BYTES + count * recordBytes;
    if (wholeBytes < data.length) {
      await fs.truncate(this.getCachePath(repoName), wholeBytes);
    }
  }

  private async convertLegacyCache(repoName: string, repo: RepoCache): Promise<boolean> {
    let parsed: Record<string, number[]>;
    try {
      parsed = JSON.parse(await fs.readFile(this.getLegacyCachePath(repoName), "utf-8"));
    } catch {
      return false;
    }
    for (const [key, vec] of Object.entries(parsed)) {
      repo.entries.set(key, Float32Array.from(vec));
    }
    if (repo.entries.size > 0) {
      await this.rewrite(repoName, repo, repo.entries);
    }
    await fs.rm(this.getLegacyCachePath(repoName), { force: true });
    console.error(`Converted JSON cache for [${repoName}] to binary`);
    return true;
  }

  // Ends a repo's full pass: drops cached embeddings whose text no chunk has any more.
  // Returns a one-line description of what happened to the cache, for the end-of-run summary.
  async saveCache(repoName: string): Promise<string> {
    const repo = this.caches.get(repoName);
    if (!repo) return "no cache";
    // No chunks at all most likely means the docs folder was unreadable this
    // time; keep the cache rather than throw every embedding away.
    if (repo.used.size === 0) return `no chunks found, kept all ${repo.entries.size} cached embeddings`;

    const stale = repo.entries.size - repo.used.size;
    if (stale === 0) return `cache kept ${repo.entries.size}, deleted 0 whose text no longer exists`;

    const kept: EmbeddingsCache = new Map();
    for (const key of repo.used) {
      kept.set(key, repo.entries.get(key)!);
    }
    await this.rewrite(repoName, repo, kept);
    repo.entries = kept;
    return `cache kept ${kept.size}, deleted ${stale} whose text no longer exists`;
  }

  // Writes the whole cache to a temp file and renames it over the old one, so
  // a crash mid-write leaves the old file intact.
  private async rewrite(repoName: string, repo: RepoCache, entries: EmbeddingsCache): Promise<void> {
    const dim = entries.values().next().value!.length;
    const parts: Buffer[] = [this.header(dim)];
    for (const [key, vec] of entries) {
      parts.push(this.record(key, vec));
    }
    await fs.mkdir(this.cacheDir, { recursive: true });
    const tmp = `${this.getCachePath(repoName)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, Buffer.concat(parts));
    await fs.rename(tmp, this.getCachePath(repoName));
    repo.dim = dim;
  }

  private header(dim: number): Buffer {
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header);
    header.writeUInt32LE(dim, MAGIC.length);
    return header;
  }

  private record(key: string, vec: Float32Array): Buffer {
    const buf = Buffer.alloc(KEY_BYTES + vec.length * 4);
    buf.write(key, 0, KEY_BYTES, "hex");
    for (let j = 0; j < vec.length; j++) {
      buf.writeFloatLE(vec[j]!, KEY_BYTES + j * 4);
    }
    return buf;
  }

  private async append(repoName: string, repo: RepoCache, key: string, vec: Float32Array): Promise<void> {
    if (repo.dim !== null && repo.dim !== vec.length) {
      throw new Error(
        `Embedding length ${vec.length} does not match the ${repo.dim} in the [${repoName}] cache; ` +
          `delete ${this.getCachePath(repoName)} after changing models`,
      );
    }
    await fs.mkdir(this.cacheDir, { recursive: true });
    const record = this.record(key, vec);
    await fs.appendFile(this.getCachePath(repoName), repo.dim === null ? Buffer.concat([this.header(vec.length), record]) : record);
    repo.dim = vec.length;
  }

  private getCacheKey(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
  }

  private getCache(repoName: string): RepoCache {
    let repo = this.caches.get(repoName);
    if (!repo) {
      repo = { entries: new Map(), used: new Set(), dim: null };
      this.caches.set(repoName, repo);
    }
    return repo;
  }

  protected async generate(text: string): Promise<number[]> {
    const response = await this.ollama.embeddings({
      model: this.embeddingModel,
      prompt: text,
    });
    return response.embedding;
  }

  async embed(text: string, repoName: string): Promise<Float32Array> {
    const repo = this.getCache(repoName);
    const cacheKey = this.getCacheKey(text);
    repo.used.add(cacheKey);

    const cached = repo.entries.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const embedding = Float32Array.from(await this.generate(text));
      await this.append(repoName, repo, cacheKey, embedding);
      repo.entries.set(cacheKey, embedding);
      return embedding;
    } catch (error) {
      console.error(`Error generating embedding: ${error}`);
      throw error;
    }
  }

  async embedQuery(text: string): Promise<Float32Array> {
    try {
      return Float32Array.from(await this.generate(text));
    } catch (error) {
      console.error(`Error generating query embedding: ${error}`);
      throw error;
    }
  }
}

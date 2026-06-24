import * as fs from "fs/promises";
import * as path from "path";
import { EmbeddingsService } from "./embeddings.js";
import { cosineSimilarity } from "./utils.js";
import type { RepoConfig } from "./config.js";

interface DocumentChunk {
  id: string;
  title: string;
  filePath: string;
  text: string;
  embedding: number[];
  repo: string;
  shared: boolean;
}

interface SearchResult {
  section: string;
  file: string;
  content: string;
  similarity: number;
  repo: string;
}

interface SearchResponse {
  results: SearchResult[];
  missing: boolean;
  suggestion: string | null;
}

export class DocumentStore {
  private chunks: DocumentChunk[] = [];
  private embeddingsService: EmbeddingsService;
  private repos: RepoConfig[];
  private maxChunkChars: number;

  constructor(repos: RepoConfig[], embeddingsService: EmbeddingsService, maxChunkChars: number) {
    this.repos = repos;
    this.embeddingsService = embeddingsService;
    this.maxChunkChars = maxChunkChars;
  }

  async loadDocumentation(repoFilter?: string): Promise<void> {
    const repos = repoFilter ? this.repos.filter((r) => r.name === repoFilter) : this.repos;

    for (const repo of repos) {
      let totalFiles = 0;
      for (const docsPath of repo.docsPaths) {
        const files = await this.getMarkdownFiles(docsPath, repo.exclude);
        totalFiles += files.length;

        for (const file of files) {
          const content = await fs.readFile(file, "utf-8");
          const fileChunks = this.chunkMarkdown(content, file, repo, docsPath);
          this.chunks.push(...fileChunks);
        }
      }
      console.error(`Found ${totalFiles} markdown files in [${repo.name}] ${repo.label}`);
    }

    console.error(`Created ${this.chunks.length} total documentation chunks`);
  }

  private async getMarkdownFiles(dir: string, exclude?: string[]): Promise<string[]> {
    const files: string[] = [];
    const excludeSet = new Set(exclude || []);

    async function walk(currentPath: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(currentPath, { withFileTypes: true });
      } catch (err) {
        // A configured docsPath (or a subdirectory) may not exist or be readable.
        // Skip it with a warning rather than crashing the whole indexing run.
        console.error(`Skipping unreadable path "${currentPath}": ${(err as Error).message}`);
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (!excludeSet.has(entry.name)) {
            await walk(fullPath);
          }
        } else if (entry.name.endsWith(".md")) {
          files.push(fullPath);
        }
      }
    }

    await walk(dir);
    return files;
  }

  private chunkMarkdown(content: string, filePath: string, repo: RepoConfig, docsPath: string): DocumentChunk[] {
    const rawChunks = this.splitByHeadings(content);
    const isShared = content.includes("<!-- @shared -->");

    const chunks: DocumentChunk[] = [];
    let chunkIndex = 0;

    for (const raw of rawChunks) {
      const subChunks = this.enforceMaxSize(raw.title, raw.text);

      for (const sub of subChunks) {
        const text = sub.text.trim();
        if (text.length >= 50) {
          chunks.push({
            id: `${filePath}#${chunkIndex}`,
            title: sub.title || "Untitled",
            filePath: path.relative(docsPath, filePath),
            text,
            embedding: [],
            repo: repo.name,
            shared: isShared,
          });
          chunkIndex++;
        }
      }
    }

    return chunks;
  }

  private splitByHeadings(content: string): Array<{ title: string; text: string }> {
    const lines = content.split("\n");
    const sections: Array<{ title: string; text: string }> = [];
    let currentTitle = "";
    let currentLines: string[] = [];

    const flush = (): void => {
      const text = currentLines.join("\n");
      if (text.trim().length > 0) {
        sections.push({ title: currentTitle, text });
      }
      currentLines = [];
    };

    for (const line of lines) {
      if (line.match(/^#{1,2}\s/)) {
        flush();
        currentTitle = line.replace(/^#{1,2}\s/, "").trim();
        currentLines.push(line);
      } else {
        currentLines.push(line);
      }
    }

    flush();
    return sections;
  }

  private enforceMaxSize(parentTitle: string, text: string): Array<{ title: string; text: string }> {
    if (text.length <= this.maxChunkChars) {
      return [{ title: parentTitle, text }];
    }

    const h3Chunks = this.splitByPattern(text, /^###\s/m);
    if (h3Chunks.length > 1) {
      const results: Array<{ title: string; text: string }> = [];
      for (const chunk of h3Chunks) {
        const title = chunk.match(/^###\s+(.+)/m)?.[1] || parentTitle;
        const fullTitle = parentTitle ? `${parentTitle} > ${title}` : title;
        results.push(...this.enforceMaxSize(fullTitle, chunk));
      }
      return results;
    }

    const paragraphs = text.split(/\n\n+/);
    if (paragraphs.length <= 1) {
      // No paragraph breaks to split on (e.g. a large code block or table).
      // Hard-split by character length so the chunk never exceeds the model's context.
      return this.hardSplit(parentTitle, text);
    }

    const results: Array<{ title: string; text: string }> = [];
    let current: string[] = [];
    let currentLen = 0;
    let partIndex = 1;

    const flushPart = (): void => {
      if (current.length === 0) return;
      results.push({ title: `${parentTitle} (part ${partIndex})`, text: current.join("\n\n") });
      current = [];
      currentLen = 0;
      partIndex++;
    };

    for (const para of paragraphs) {
      // A single paragraph larger than the limit can't be packed — hard-split it on its own.
      if (para.length > this.maxChunkChars) {
        flushPart();
        for (const piece of this.hardSplit(parentTitle, para)) {
          results.push({ title: `${parentTitle} (part ${partIndex})`, text: piece.text });
          partIndex++;
        }
        continue;
      }
      if (currentLen + para.length > this.maxChunkChars && current.length > 0) {
        flushPart();
      }
      current.push(para);
      currentLen += para.length;
    }

    if (current.length > 0) {
      const title = partIndex > 1 ? `${parentTitle} (part ${partIndex})` : parentTitle;
      results.push({ title, text: current.join("\n\n") });
    }

    return results;
  }

  private hardSplit(title: string, text: string): Array<{ title: string; text: string }> {
    if (text.length <= this.maxChunkChars) {
      return [{ title, text }];
    }
    const results: Array<{ title: string; text: string }> = [];
    for (let i = 0; i < text.length; i += this.maxChunkChars) {
      results.push({ title, text: text.slice(i, i + this.maxChunkChars) });
    }
    return results;
  }

  private splitByPattern(text: string, pattern: RegExp): string[] {
    const lines = text.split("\n");
    const sections: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
      if (line.match(pattern) && current.length > 0) {
        sections.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    }

    if (current.length > 0) {
      sections.push(current.join("\n"));
    }

    return sections;
  }

  async indexChunks(repoFilter?: string): Promise<void> {
    const chunksToIndex = repoFilter
      ? this.chunks.filter((c) => c.repo === repoFilter)
      : this.chunks;

    console.error(`Indexing ${chunksToIndex.length} documentation chunks...`);

    for (let i = 0; i < chunksToIndex.length; i++) {
      const chunk = chunksToIndex[i]!;
      chunk.embedding = await this.embeddingsService.embed(chunk.text, chunk.repo);

      if ((i + 1) % 5 === 0) {
        console.error(`Indexed ${i + 1}/${chunksToIndex.length} chunks`);
      }
    }

    console.error("Indexing complete");
  }

  async search(query: string, topK: number = 5, threshold: number = 0.3, repo?: string): Promise<SearchResponse> {
    const queryEmbedding = await this.embeddingsService.embedQuery(query);

    let candidates = this.chunks;
    if (repo) {
      candidates = candidates.filter((chunk) => chunk.repo === repo || chunk.shared);
    }

    const scored = candidates.map((chunk) => ({
      ...chunk,
      similarity: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    const filtered = scored
      .filter((item) => item.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    const results: SearchResult[] = filtered.map((item) => ({
      section: item.title,
      file: item.filePath,
      content: item.text,
      similarity: Math.round(item.similarity * 1000) / 1000,
      repo: item.repo,
    }));

    const missing = results.length === 0 || (results.length > 0 && results[0]!.similarity < 0.5);
    const repoContext = repo ? ` in repo "${repo}"` : "";
    const suggestion = missing
      ? `No strong documentation match found for "${query}"${repoContext}. Consider adding documentation about this topic.`
      : null;

    return {
      results,
      missing,
      suggestion,
    };
  }

  async listFiles(repoFilter?: string, dirPath?: string): Promise<Array<{ repo: string; label: string; file: string; fileCount?: number }>> {
    const repos = repoFilter ? this.repos.filter((r) => r.name === repoFilter) : this.repos;
    const results: Array<{ repo: string; label: string; file: string; fileCount?: number }> = [];

    for (const repo of repos) {
      for (const docsPath of repo.docsPaths) {
        const files = await this.getMarkdownFiles(docsPath, repo.exclude);
        const relativePaths = files.map((f) => path.relative(docsPath, f));

        // Filter to dirPath if provided
        const filtered = dirPath
          ? relativePaths.filter((f) => f.startsWith(dirPath.endsWith("/") ? dirPath : dirPath + "/"))
          : relativePaths;

        // Group: top-level files listed individually, subdirectories collapsed with counts
        const topLevelFiles: string[] = [];
        const dirCounts: Record<string, number> = {};
        const prefix = dirPath ? (dirPath.endsWith("/") ? dirPath : dirPath + "/") : "";

        for (const f of filtered) {
          const relative = prefix ? f.slice(prefix.length) : f;
          const slashIdx = relative.indexOf("/");
          if (slashIdx === -1) {
            topLevelFiles.push(f);
          } else {
            const dir = prefix + relative.slice(0, slashIdx);
            dirCounts[dir] = (dirCounts[dir] || 0) + 1;
          }
        }

        for (const file of topLevelFiles) {
          results.push({ repo: repo.name, label: repo.label, file });
        }
        for (const [dir, count] of Object.entries(dirCounts).sort()) {
          results.push({ repo: repo.name, label: repo.label, file: dir + "/", fileCount: count });
        }
      }
    }

    return results;
  }

  async readFile(repo: string, filePath: string): Promise<{ content: string; repo: string; file: string } | null> {
    const repoConfig = this.repos.find((r) => r.name === repo);
    if (!repoConfig) return null;

    for (const docsPath of repoConfig.docsPaths) {
      const resolvedDocsPath = path.resolve(docsPath);
      const fullPath = path.resolve(docsPath, filePath);
      // Prevent path traversal outside docsPath
      if (!fullPath.startsWith(resolvedDocsPath + path.sep)) return null;

      try {
        const content = await fs.readFile(fullPath, "utf-8");
        return { content, repo, file: filePath };
      } catch {
        // Try next docsPath
      }
    }

    return null;
  }

  getChunkCount(): number {
    return this.chunks.length;
  }

  getRepoChunkCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const chunk of this.chunks) {
      counts[chunk.repo] = (counts[chunk.repo] || 0) + 1;
    }
    return counts;
  }
}

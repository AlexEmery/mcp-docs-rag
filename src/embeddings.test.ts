import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { EmbeddingsService } from "./embeddings.js";

// Embeds without Ollama: the vector is derived from the text, and every call is counted.
class FakeEmbeddings extends EmbeddingsService {
  calls = 0;
  constructor(cacheDir: string) {
    super(cacheDir, "http://unused", "fake");
  }
  protected override async generate(text: string): Promise<number[]> {
    this.calls++;
    return [text.length, text.charCodeAt(0), 0.5];
  }
}

async function tempCache(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "docs-rag-emb-"));
}

const binPath = (dir: string) => path.join(dir, "r.embeddings.bin");

test("embeddings survive a crash before the pass ends", async () => {
  const dir = await tempCache();
  const first = new FakeEmbeddings(dir);
  await first.loadCache("r");
  await first.embed("alpha", "r");
  await first.embed("beta", "r");
  // No saveCache: the process died mid-pass.

  const second = new FakeEmbeddings(dir);
  await second.loadCache("r");
  assert.deepEqual(Array.from(await second.embed("alpha", "r")), [5, 97, 0.5]);
  await second.embed("beta", "r");
  assert.equal(second.calls, 0);
});

test("a half-written last record is cut off and later appends still load", async () => {
  const dir = await tempCache();
  const first = new FakeEmbeddings(dir);
  await first.loadCache("r");
  await first.embed("alpha", "r");
  await fs.appendFile(binPath(dir), Buffer.from([1, 2, 3, 4, 5]));

  const second = new FakeEmbeddings(dir);
  await second.loadCache("r");
  await second.embed("gamma", "r");

  const third = new FakeEmbeddings(dir);
  await third.loadCache("r");
  await third.embed("alpha", "r");
  await third.embed("gamma", "r");
  assert.equal(third.calls, 0);
});

test("read-only cache loading ignores a partial record without changing the file", async () => {
  const dir = await tempCache();
  const first = new FakeEmbeddings(dir);
  await first.loadCache("r");
  await first.embed("alpha", "r");
  await fs.appendFile(binPath(dir), Buffer.from([1, 2, 3, 4, 5]));
  const before = (await fs.stat(binPath(dir))).size;

  const second = new FakeEmbeddings(dir);
  await second.loadCache("r", { readOnly: true });
  assert.deepEqual(Array.from(second.getCached("alpha", "r")!), [5, 97, 0.5]);
  assert.equal((await fs.stat(binPath(dir))).size, before);
});

test("ending a pass drops embeddings for text that no chunk has any more", async () => {
  const dir = await tempCache();
  const first = new FakeEmbeddings(dir);
  await first.loadCache("r");
  await first.embed("old text", "r");
  await first.embed("kept", "r");
  await first.saveCache("r");
  const before = (await fs.stat(binPath(dir))).size;

  const second = new FakeEmbeddings(dir);
  await second.loadCache("r");
  await second.embed("kept", "r");
  await second.saveCache("r");
  assert.ok((await fs.stat(binPath(dir))).size < before);

  const third = new FakeEmbeddings(dir);
  await third.loadCache("r");
  await third.embed("kept", "r");
  assert.equal(third.calls, 0);
  await third.embed("old text", "r");
  assert.equal(third.calls, 1);
});

test("a pass that saw no chunks keeps the cache", async () => {
  const dir = await tempCache();
  const first = new FakeEmbeddings(dir);
  await first.loadCache("r");
  await first.embed("alpha", "r");

  const second = new FakeEmbeddings(dir);
  await second.loadCache("r");
  await second.saveCache("r");

  const third = new FakeEmbeddings(dir);
  await third.loadCache("r");
  await third.embed("alpha", "r");
  assert.equal(third.calls, 0);
});

test("an old JSON cache is converted and removed", async () => {
  const dir = await tempCache();
  const seed = new FakeEmbeddings(dir);
  // Build the JSON the old version wrote, keyed the same way.
  await seed.loadCache("seed");
  const vec = await seed.embed("alpha", "seed");
  const crypto = await import("crypto");
  const key = crypto.createHash("sha256").update("alpha").digest("hex");
  await fs.writeFile(path.join(dir, "r.embeddings.json"), JSON.stringify({ [key]: Array.from(vec) }));

  const svc = new FakeEmbeddings(dir);
  await svc.loadCache("r");
  assert.deepEqual(Array.from(await svc.embed("alpha", "r")), [5, 97, 0.5]);
  assert.equal(svc.calls, 0);
  await assert.rejects(fs.access(path.join(dir, "r.embeddings.json")));
  await fs.access(binPath(dir));
});

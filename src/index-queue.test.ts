import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { indexQueued, mergeRepos, withIndexLock, type RepoSet } from "./index-queue.js";

const quiet = { pollMs: 50, log: () => {} };

async function tempCache(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "docs-rag-queue-"));
}

function deadPid(): number {
  return spawnSync("true").pid!;
}

async function waitForRequests(cacheDir: string, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const names = await fs.readdir(path.join(cacheDir, "index-queue")).catch(() => []);
    if (names.filter((n) => n.endsWith(".json")).length >= count) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`fewer than ${count} requests queued`);
}

function blocker(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
}

test("requests queued behind a running pass are merged into one pass", async () => {
  const cacheDir = await tempCache();
  const passes: RepoSet[] = [];
  const first = blocker();
  const runPass = async (repos: RepoSet) => {
    passes.push(repos);
    if (passes.length === 1) await first.wait;
  };

  const a = indexQueued(cacheDir, ["pm-bot"], runPass, quiet);
  await waitForRequests(cacheDir, 1);
  while (passes.length === 0) await new Promise((r) => setTimeout(r, 10));
  const b = indexQueued(cacheDir, ["pm-bot", "api"], runPass, quiet);
  const c = indexQueued(cacheDir, ["api", "rc"], runPass, quiet);
  await waitForRequests(cacheDir, 3);
  first.release();
  await Promise.all([a, b, c]);

  assert.deepEqual(passes, [["pm-bot"], ["api", "pm-bot", "rc"]]);
});

test("only one pass runs at a time", async () => {
  const cacheDir = await tempCache();
  let running = 0;
  let most = 0;
  const runPass = async () => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 30));
    running--;
  };
  await Promise.all(Array.from({ length: 6 }, (_, i) => indexQueued(cacheDir, [`r${i % 3}`], runPass, quiet)));
  assert.equal(most, 1);
});

test("all repos absorbs any named repo", () => {
  assert.equal(mergeRepos([["pm-bot"], "all", ["api"]]), "all");
  assert.deepEqual(mergeRepos([["b", "a"], ["a"]]), ["a", "b"]);
});

test("a lock left by a process that died is taken over", async () => {
  const cacheDir = await tempCache();
  await fs.mkdir(path.join(cacheDir, "index-queue"), { recursive: true });
  await fs.writeFile(path.join(cacheDir, "index-queue", "index.lock"), String(deadPid()));
  const passes: RepoSet[] = [];
  await indexQueued(cacheDir, ["pm-bot"], async (repos) => void passes.push(repos), quiet);
  assert.deepEqual(passes, [["pm-bot"]]);
});

test("a request from a process that died is dropped, not indexed", async () => {
  const cacheDir = await tempCache();
  const queueDir = path.join(cacheDir, "index-queue");
  await fs.mkdir(queueDir, { recursive: true });
  await fs.writeFile(path.join(queueDir, "0-dead.json"), JSON.stringify({ id: "0-dead", pid: deadPid(), repos: ["gone"] }));
  const passes: RepoSet[] = [];
  await indexQueued(cacheDir, ["pm-bot"], async (repos) => void passes.push(repos), quiet);
  assert.deepEqual(passes, [["pm-bot"]]);
  assert.deepEqual((await fs.readdir(queueDir)).sort(), []);
});

test("loading the server's store waits for a running pass", async () => {
  const cacheDir = await tempCache();
  const order: string[] = [];
  const pass = blocker();
  const indexing = indexQueued(cacheDir, "all", async () => {
    order.push("pass start");
    await pass.wait;
    order.push("pass end");
  }, quiet);
  while (order.length === 0) await new Promise((r) => setTimeout(r, 10));
  const loading = withIndexLock(cacheDir, async () => void order.push("server load"), quiet);
  await new Promise((r) => setTimeout(r, 150));
  pass.release();
  await Promise.all([indexing, loading]);
  assert.deepEqual(order, ["pass start", "pass end", "server load"]);
});

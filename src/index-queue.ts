import * as fs from "fs/promises";
import { watch } from "fs";
import * as path from "path";
import * as crypto from "crypto";

// One index pass runs at a time across every process on the machine. A process that wants an
// index writes a request into the queue folder; whichever process holds the lock runs one pass
// over the union of every request queued when the pass starts, then marks each of those requests
// done. Requests that arrive during a pass wait for the next one, because the docs they want
// indexed may have changed after this pass read them.

export type RepoSet = string[] | "all";

interface IndexRequest {
  id: string;
  pid: number;
  repos: RepoSet;
}

export interface QueueOptions {
  pollMs?: number;
  log?: (message: string) => void;
}

const LOCK_FILE = "index.lock";
const QUEUE_DIR = "index-queue";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function mergeRepos(sets: RepoSet[]): RepoSet {
  if (sets.some((s) => s === "all")) return "all";
  return [...new Set(sets.flatMap((s) => s as string[]))].sort();
}

async function tryLock(lockPath: string): Promise<boolean> {
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const holder = Number((await fs.readFile(lockPath, "utf-8").catch(() => "")).trim());
  if (holder && pidAlive(holder)) return false;
  await fs.unlink(lockPath).catch(() => {});
  return tryLock(lockPath);
}

async function readRequests(queueDir: string): Promise<IndexRequest[]> {
  const names = (await fs.readdir(queueDir)).filter((n) => n.endsWith(".json")).sort();
  const requests: IndexRequest[] = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(queueDir, name), "utf-8").catch(() => null);
    if (text === null) continue;
    const request = JSON.parse(text) as IndexRequest;
    if (pidAlive(request.pid)) {
      requests.push(request);
    } else {
      await fs.unlink(path.join(queueDir, name)).catch(() => {});
    }
  }
  return requests;
}

function waitForChange(dir: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(dir, () => finish());
    const timer = setTimeout(() => finish(), ms);
    function finish(): void {
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
  });
}

export async function withIndexLock<T>(cacheDir: string, work: () => Promise<T>, options: QueueOptions = {}): Promise<T> {
  const pollMs = options.pollMs ?? 2000;
  const queueDir = path.join(cacheDir, QUEUE_DIR);
  await fs.mkdir(queueDir, { recursive: true });
  const lockPath = path.join(queueDir, LOCK_FILE);
  while (!(await tryLock(lockPath))) {
    await waitForChange(queueDir, pollMs);
  }
  try {
    return await work();
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
}

export async function indexQueued(
  cacheDir: string,
  repos: RepoSet,
  runPass: (repos: RepoSet) => Promise<void>,
  options: QueueOptions = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 2000;
  const log = options.log ?? ((m: string) => console.error(m));
  const queueDir = path.join(cacheDir, QUEUE_DIR);
  const lockPath = path.join(queueDir, LOCK_FILE);
  await fs.mkdir(queueDir, { recursive: true });

  const id = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const requestPath = path.join(queueDir, `${id}.json`);
  const donePath = path.join(queueDir, `${id}.done`);
  await fs.writeFile(requestPath, JSON.stringify({ id, pid: process.pid, repos } satisfies IndexRequest));

  let announced = false;
  for (;;) {
    if (await fs.unlink(donePath).then(() => true, () => false)) return;

    if (await tryLock(lockPath)) {
      try {
        const batch = await readRequests(queueDir);
        if (batch.length > 0) {
          const merged = mergeRepos(batch.map((r) => r.repos));
          log(`Indexing ${merged === "all" ? "all repos" : merged.join(", ")} in one pass for ${batch.length} queued request(s)`);
          await runPass(merged);
          for (const request of batch) {
            if (pidAlive(request.pid)) {
              await fs.writeFile(path.join(queueDir, `${request.id}.done`), "");
            }
            await fs.unlink(path.join(queueDir, `${request.id}.json`)).catch(() => {});
          }
        }
      } finally {
        await fs.unlink(lockPath).catch(() => {});
      }
      continue;
    }

    if (!announced) {
      const holder = (await fs.readFile(lockPath, "utf-8").catch(() => "")).trim();
      log(`Another index pass is running (pid ${holder || "unknown"}); queued behind it`);
      announced = true;
    }
    await waitForChange(queueDir, pollMs);
  }
}

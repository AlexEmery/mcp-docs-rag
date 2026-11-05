import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { startAutoIndexing } from "./auto-index.js";
import type { RepoConfig } from "./config.js";
import type { RepoSet } from "./index-queue.js";

function recorder() {
  const batches: RepoSet[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const notify = (): void => {
    for (const waiter of [...waiters]) {
      if (batches.length >= waiter.count) {
        waiter.resolve();
        waiters.splice(waiters.indexOf(waiter), 1);
      }
    }
  };
  return {
    batches,
    run: async (repos: RepoSet) => {
      batches.push(repos);
      notify();
    },
    waitFor: (count: number): Promise<void> => {
      if (batches.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

async function fixture(): Promise<{ docsPath: string; repo: RepoConfig }> {
  const docsPath = await fs.mkdtemp(path.join(os.tmpdir(), "docs-rag-watch-"));
  return {
    docsPath,
    repo: { name: "api", label: "API", docsPaths: [docsPath] },
  };
}

test("indexes at startup and reindexes a repo when its docs change", async () => {
  const { docsPath, repo } = await fixture();
  const calls = recorder();
  const indexer = startAutoIndexing([repo], calls.run, { debounceMs: 20, intervalMs: 60_000 });
  try {
    await calls.waitFor(1);
    await fs.writeFile(path.join(docsPath, "guide.md"), "# Guide\n");
    await calls.waitFor(2);
    assert.deepEqual(calls.batches, ["all", ["api"]]);
  } finally {
    indexer.close();
  }
});

test("periodically indexes even without a filesystem event", async () => {
  const { repo } = await fixture();
  const calls = recorder();
  const indexer = startAutoIndexing([{ ...repo, docsPaths: [] }], calls.run, { debounceMs: 1, intervalMs: 20 });
  try {
    await calls.waitFor(2);
    assert.deepEqual(calls.batches.slice(0, 2), ["all", "all"]);
  } finally {
    indexer.close();
  }
});

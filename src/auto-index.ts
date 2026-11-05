import { watch, type FSWatcher } from "fs";
import type { RepoConfig } from "./config.js";
import { mergeRepos, type RepoSet } from "./index-queue.js";

export interface AutoIndexOptions {
  debounceMs?: number;
  intervalMs?: number;
  log?: (message: string) => void;
}

export interface AutoIndexer {
  close: () => void;
}

export function startAutoIndexing(
  repos: RepoConfig[],
  runIndex: (repos: RepoSet) => Promise<void>,
  options: AutoIndexOptions = {},
): AutoIndexer {
  const debounceMs = options.debounceMs ?? 1000;
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
  const log = options.log ?? ((message: string) => console.error(message));
  const watchers: FSWatcher[] = [];
  let pending: RepoSet = [];
  let running = false;
  let closed = false;
  let debounce: NodeJS.Timeout | undefined;
  let interval: NodeJS.Timeout | undefined;

  const schedule = (): void => {
    if (closed || pending.length === 0) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void drain();
    }, debounceMs);
  };

  const request = (reposToIndex: RepoSet): void => {
    if (closed) return;
    pending = mergeRepos([pending, reposToIndex]);
    schedule();
  };

  const drain = async (): Promise<void> => {
    if (closed || running || pending.length === 0) return;
    const batch = pending;
    pending = [];
    running = true;
    try {
      await runIndex(batch);
    } catch (error) {
      log(`Automatic indexing failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      schedule();
    }
  };

  for (const repo of repos) {
    for (const docsPath of repo.docsPaths) {
      try {
        const watcher = watch(docsPath, { recursive: true }, () => request([repo.name]));
        watcher.on("error", (error) => {
          log(`Documentation watcher failed for "${docsPath}": ${error.message}; periodic indexing will continue`);
        });
        watchers.push(watcher);
      } catch (error) {
        log(
          `Cannot watch documentation path "${docsPath}": ${error instanceof Error ? error.message : String(error)}; periodic indexing will continue`,
        );
      }
    }
  }

  if (repos.length > 0) {
    request("all");
    interval = setInterval(() => request("all"), intervalMs);
  }

  return {
    close: () => {
      closed = true;
      if (debounce) clearTimeout(debounce);
      if (interval) clearInterval(interval);
      for (const watcher of watchers) watcher.close();
    },
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import { utimesSync } from "fs";
import * as os from "os";
import * as path from "path";
import { rebuildIfStale, type Runner } from "./self-build.js";

// A package folder with old timestamps everywhere: installed, built, nothing changed since.
async function fakePackage(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "docs-rag-build-"));
  const files = ["package.json", "pnpm-lock.yaml", "tsconfig.json", "src/a.ts", "node_modules/.modules.yaml", "dist/main.js"];
  for (const [i, file] of files.entries()) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), "");
    const t = new Date(Date.UTC(2020, 0, 1, 0, 0, i));
    await fs.utimes(path.join(root, file), t, t);
  }
  return root;
}

// Records commands and makes each one bring its output up to date, as the real one would.
function recorder(root: string): { runs: string[]; run: Runner } {
  const runs: string[] = [];
  return {
    runs,
    run: (command) => {
      runs.push(command === "pnpm" ? "install" : "build");
      const out = command === "pnpm" ? "node_modules/.modules.yaml" : "dist/main.js";
      // Sync, like the real spawnSync runner.
      utimesSync(path.join(root, out), new Date(), new Date());
      return true;
    },
  };
}

const built = (root: string) => path.join(root, "dist", "main.js");

test("nothing runs when the build is current", async () => {
  const root = await fakePackage();
  const { runs, run } = recorder(root);
  await rebuildIfStale(root, built(root), run);
  assert.deepEqual(runs, []);
});

test("a changed source file triggers a build only", async () => {
  const root = await fakePackage();
  await fs.writeFile(path.join(root, "src", "a.ts"), "changed");
  const { runs, run } = recorder(root);
  await rebuildIfStale(root, built(root), run);
  assert.deepEqual(runs, ["build"]);
  await rebuildIfStale(root, built(root), run);
  assert.deepEqual(runs, ["build"]);
});

test("a changed lockfile triggers install then build", async () => {
  const root = await fakePackage();
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "changed");
  await fs.writeFile(path.join(root, "package.json"), "{}");
  const { runs, run } = recorder(root);
  await rebuildIfStale(root, built(root), run);
  assert.deepEqual(runs, ["install", "build"]);
});

test("starts at the same time build once", async () => {
  const root = await fakePackage();
  await fs.writeFile(path.join(root, "src", "a.ts"), "changed");
  const { runs, run } = recorder(root);
  await Promise.all([1, 2, 3].map(() => rebuildIfStale(root, built(root), run)));
  assert.deepEqual(runs, ["build"]);
});

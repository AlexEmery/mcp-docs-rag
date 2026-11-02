import * as fs from "fs/promises";
import * as path from "path";
import { spawnSync } from "child_process";
import { withFileLock } from "./index-queue.js";

// Rebuilds the package when its source is newer than its build, so a `git pull`
// takes effect on the next start without a manual `pnpm build`.

export type Runner = (command: string, args: string[], cwd: string) => boolean;

// Output goes to stderr: stdout is the MCP protocol channel.
const runCommand: Runner = (command, args, cwd) =>
  spawnSync(command, args, { cwd, stdio: ["ignore", 2, 2] }).status === 0;

async function mtime(file: string): Promise<number> {
  return (await fs.stat(file).catch(() => null))?.mtimeMs ?? 0;
}

async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? await newestMtime(full) : await mtime(full));
  }
  return newest;
}

async function depsStale(root: string): Promise<boolean> {
  const installed = await mtime(path.join(root, "node_modules", ".modules.yaml"));
  const wanted = Math.max(await mtime(path.join(root, "package.json")), await mtime(path.join(root, "pnpm-lock.yaml")));
  return wanted > installed;
}

async function buildStale(root: string, builtFile: string): Promise<boolean> {
  const source = Math.max(
    await newestMtime(path.join(root, "src")),
    await mtime(path.join(root, "tsconfig.json")),
    await mtime(path.join(root, "package.json")),
  );
  return source > (await mtime(builtFile));
}

// builtFile is a file every build rewrites; it standing older than any source means the build is stale.
export async function rebuildIfStale(root: string, builtFile: string, run: Runner = runCommand): Promise<void> {
  if (!(await depsStale(root)) && !(await buildStale(root, builtFile))) return;

  // Several servers start at once after a pull; only one builds, the rest wait for it.
  await withFileLock(path.join(root, ".build.lock"), async () => {
    if (await depsStale(root)) {
      console.error("Dependencies changed; running pnpm install");
      if (!run("pnpm", ["install", "--frozen-lockfile"], root)) {
        console.error("pnpm install failed; starting with the dependencies already installed");
      }
    }
    if (await buildStale(root, builtFile)) {
      console.error("Source is newer than the build; rebuilding");
      if (!run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc")], root)) {
        console.error("Rebuild failed; starting with the existing build");
      }
    }
  }, 200);
}

#!/usr/bin/env node

// Entry point: rebuild if the source changed since the last build, then load the program.
// The program is imported only after the rebuild so it runs the fresh build.

import * as path from "path";
import { fileURLToPath } from "url";
import { rebuildIfStale } from "./self-build.js";

const here = path.dirname(fileURLToPath(import.meta.url));
await rebuildIfStale(path.join(here, ".."), path.join(here, "main.js"));
await import("./main.js");

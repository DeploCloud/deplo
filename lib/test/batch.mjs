// One `node --test` child that runs test files back to back, each in its own
// describe() so its top-level hooks stay its own (scripts/test.mjs).
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, mock } from "node:test";

const require = createRequire(import.meta.url);
const FILE_KEY = Symbol.for("deplo.test.file");
const FILE_TIMEOUT_MS = 10 * 60_000;

export async function runShard(runDir) {
  const files = JSON.parse(
    readFileSync(path.join(runDir, "files.json"), "utf8"),
  );
  try {
    for (let i = 0; i < files.length; i++) {
      try {
        mkdirSync(path.join(runDir, "claims", String(i)));
      } catch {
        continue;
      }
      await runFile(files[i]);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  await forceExit();
}

async function runFile(file) {
  const env = { ...process.env };
  const fetch = globalThis.fetch;
  const known = new Set(Object.getOwnPropertySymbols(globalThis));
  const slots = scalarSlots();
  globalThis[FILE_KEY] = file;
  await describe(file, { timeout: FILE_TIMEOUT_MS }, () => {
    require(path.resolve(file));
  });
  mock.reset();
  globalThis.fetch = fetch;
  for (const k of Object.keys(process.env))
    if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  for (const k of scalarSlots().keys()) if (!known.has(k)) delete globalThis[k];
  for (const [k, v] of slots) if (globalThis[k] !== v) globalThis[k] = v;
}

// Values parked on globalThis (the stored panel address, say) go back to what the
// file found; a Map or a store a module captured at load cannot be reset this way.
function scalarSlots() {
  const out = new Map();
  for (const k of Object.getOwnPropertySymbols(globalThis)) {
    const v = globalThis[k];
    const name = Symbol.keyFor(k);
    if (name === undefined || name.startsWith("deplo.test.")) continue;
    if (v === null || (typeof v !== "object" && typeof v !== "function"))
      out.set(k, v);
  }
  return out;
}

// What --test-force-exit does, which cannot be passed here: it fires the moment
// one file's suite ends, before the next file is claimed.
async function forceExit() {
  const flushed = new Promise((resolve) =>
    process.stdout.once("unpipe", resolve),
  );
  process.emit("beforeExit", 0);
  await flushed;
  process.exit();
}

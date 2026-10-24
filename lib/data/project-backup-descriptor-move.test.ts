import { test } from "node:test";
import assert from "node:assert/strict";

import { appMoveLeftBehind } from "./project-backup-descriptor";
import type { App } from "../types/app";

const app = (patch: Partial<App>): App =>
  ({
    source: "github",
    repo: { provider: "github", url: "u", repo: "o/r", branch: "main" },
    dockerImage: null,
    compose: null,
    volumes: null,
    ...patch,
  }) as App;

test("a move names the repository folders a source-built stack writes, which stay behind", () => {
  const compose = `services:\n  app:\n    build: ./app\n    volumes: ["./data:/data", "./conf:/etc/x:ro", "cache:/c"]\nvolumes:\n  cache: {}\n`;
  assert.deepEqual(appMoveLeftBehind(app({ compose }), ""), [
    "folder ./data of the repository's copy on that server",
  ]);
  // A pasted stack keeps those folders in its Files, which a move does carry.
  assert.deepEqual(
    appMoveLeftBehind(app({ source: "compose", repo: null, compose }), ""),
    [],
  );
});

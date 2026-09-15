import { test } from "node:test";
import assert from "node:assert/strict";

test("the data phase never names a product (ADR-0026)", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = new URL("./", import.meta.url);
  const files = (await readdir(dir)).filter(
    (f) => !/(\.test\.ts|-test-helpers\.ts)$/.test(f),
  );
  assert.ok(files.length > 0, "the data phase modules have to be readable");
  for (const file of files) {
    const source = await readFile(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /Dokploy|Coolify/, file);
  }
});

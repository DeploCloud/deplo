import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyEnvItems,
  readableEnvItems,
  retainEnvSelection,
  runEnvBulk,
  type BulkEnvItem,
} from "./env-bulk";

test("copy includes only readable Plain values and keeps scopes and special characters", () => {
  const items: BulkEnvItem[] = [
    { id: "a", key: "PORT", type: "plain", value: "3000", scope: "API" },
    { id: "b", key: "TOKEN", type: "secret", value: "never-copy" },
    { id: "c", key: "MASKED", type: "plain", masked: true, value: "hidden" },
    { id: "d", key: "PREVIEW", type: "plain" },
    { id: "e", key: "EMPTY", type: "plain", value: "" },
    { id: "f", key: "TEXT", type: "plain", value: 'line 1\n"line 2"\\' },
  ];
  assert.deepEqual(
    readableEnvItems(items).map((item) => item.id),
    ["a", "e", "f"],
  );
  assert.equal(
    copyEnvItems(items),
    '# API\nPORT="3000"\nEMPTY=""\nTEXT=' + JSON.stringify(items[5].value),
  );
});

test("filtering and collapsing discard hidden selections without restoring them later", () => {
  const selected = new Set(["a", "b", "deleted"]);
  const filtered = retainEnvSelection(selected, ["a", "c"]);
  assert.deepEqual([...filtered], ["a"]);
  assert.deepEqual([...retainEnvSelection(filtered, ["a", "b", "c"])], ["a"]);
  assert.deepEqual([...selected], ["a", "b", "deleted"]);
});

test("bulk keeps successes, reports individual errors and continues after a thrown request", async () => {
  const calls: string[] = [];
  const rows: BulkEnvItem[] = [
    {
      id: "a",
      key: "A",
      remove: async () => {
        calls.push("a");
        return { ok: true };
      },
    },
    {
      id: "b",
      key: "B",
      remove: async () => {
        calls.push("b");
        return { ok: false, error: "Permission denied" };
      },
    },
    {
      id: "c",
      key: "C",
      remove: async () => {
        calls.push("c");
        throw new Error("Disconnected");
      },
    },
    { id: "readonly", key: "READ_ONLY" },
    {
      id: "d",
      key: "D",
      remove: async () => {
        calls.push("d");
        return { ok: true };
      },
    },
  ];
  assert.deepEqual(await runEnvBulk(rows, "remove"), {
    succeeded: ["a", "d"],
    failed: ["b", "c"],
    errors: ["B: Permission denied", "C: Disconnected"],
  });
  assert.deepEqual(calls, ["a", "b", "c", "d"]);
});

test("a shared variable selected in several apps is converted once", async () => {
  let calls = 0;
  const makeSecret = async () => {
    calls++;
    return { ok: true as const };
  };
  const result = await runEnvBulk(
    [
      { id: "app-a:shared", key: "TOKEN", secretId: "shared", makeSecret },
      { id: "app-b:shared", key: "TOKEN", secretId: "shared", makeSecret },
    ],
    "makeSecret",
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.succeeded, ["app-a:shared", "app-b:shared"]);
  assert.deepEqual(result.failed, []);
});

test("failed shared conversions keep every selected reference for retry", async () => {
  let calls = 0;
  const makeSecret = async () => {
    calls++;
    return { ok: false as const, error: "Not found" };
  };
  const result = await runEnvBulk(
    [
      { id: "app-a:shared", key: "TOKEN", secretId: "shared", makeSecret },
      { id: "app-b:shared", key: "TOKEN", secretId: "shared", makeSecret },
    ],
    "makeSecret",
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.failed, ["app-a:shared", "app-b:shared"]);
  assert.deepEqual(result.succeeded, []);
});

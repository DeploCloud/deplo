import { test } from "node:test";
import assert from "node:assert/strict";

import { connectWhenReady } from "./migrate";

const failing = (codes: (string | undefined)[]) => {
  let calls = 0;
  return {
    calls: () => calls,
    connect: async () => {
      const code = codes[calls++];
      if (calls > codes.length) return "client";
      throw Object.assign(new Error(code ?? "boom"), { code });
    },
  };
};

test("a database still starting after a reboot is waited for, not taken for a broken schema", async () => {
  const db = failing(["ENOTFOUND", "ECONNREFUSED", "57P03"]);
  assert.equal(await connectWhenReady(db.connect, { delayMs: 0 }), "client");
  assert.equal(db.calls(), 4);
});

test("any other failure, or a database that never comes up, still stops the boot", async () => {
  const wrong = failing(["28P01"]);
  await assert.rejects(
    connectWhenReady(wrong.connect, { delayMs: 0 }),
    /28P01/,
  );
  assert.equal(wrong.calls(), 1);
  const never = failing(Array(5).fill("ECONNREFUSED"));
  await assert.rejects(
    connectWhenReady(never.connect, { attempts: 3, delayMs: 0 }),
    /ECONNREFUSED/,
  );
  assert.equal(never.calls(), 3);
});

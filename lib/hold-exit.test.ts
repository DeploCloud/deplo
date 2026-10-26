import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { holdExitUntil } from "./hold-exit";

describe("holdExitUntil", () => {
  const realExit = process.exit;
  let codes: (number | string | null | undefined)[] = [];
  const stubExit = () => {
    codes = [];
    process.exit = ((code?: number | string | null) => {
      codes.push(code);
    }) as typeof process.exit;
  };
  afterEach(() => {
    process.exit = realExit;
  });

  test("an exit waits for the shutdown work, then keeps its code", async () => {
    stubExit();
    let finish!: () => void;
    holdExitUntil(new Promise<void>((r) => (finish = r)), 5_000);
    process.exit(143);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(codes, [], "exited before the leases were released");
    finish();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(codes, [143]);
  });

  test("work that hangs or fails never keeps the process up past the cap", async () => {
    stubExit();
    holdExitUntil(new Promise(() => {}), 30);
    process.exit(130);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(codes, [130]);

    stubExit();
    holdExitUntil(Promise.reject(new Error("db down")), 5_000);
    process.exit(143);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(codes, [143]);
  });
});

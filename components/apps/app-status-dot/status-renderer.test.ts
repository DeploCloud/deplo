import { test } from "node:test";
import assert from "node:assert/strict";

import { OUT_OF_REACH } from "@/lib/apps/display-status";
import { detailFor } from "./status-renderer";

test("an App whose cluster Deplo cannot reach says its servers decide on their own, not that too few answer", () => {
  const runtime = (offlineWhy: string) =>
    ({ unreachable: true, offlineWhy }) as Parameters<typeof detailFor>[0];
  assert.match(
    detailFor(runtime(`${OUT_OF_REACH} since 05:32 UTC`)) ?? "",
    /No server of its cluster answers Deplo, so its servers decide on their own/,
  );
  assert.match(
    detailFor(runtime("Offline: waiting for a majority of servers")) ?? "",
    /too few servers of its cluster answer each other/,
  );
});

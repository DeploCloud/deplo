import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  captureFetch,
  type FetchCapture,
} from "../notify/fetch-capture-test-helpers";
import { fetchEpss } from "./epss";

let capture: FetchCapture | null = null;
afterEach(() => {
  capture?.restore();
  capture = null;
});

test("fetchEpss: only CVE ids go out, a hundred per call, scores in hundredths of a percent", async () => {
  capture = captureFetch((url) => {
    const ids = new URL(url).searchParams.get("cve")!.split(",");
    return new Response(
      JSON.stringify({
        data: ids.map((cve, i) => ({
          cve,
          epss: i === 0 ? "0.123456" : "0.000400",
          percentile: "0.950000",
        })),
      }),
    );
  });
  const ids = Array.from({ length: 150 }, (_, i) => `CVE-2026-${1000 + i}`);
  const out = await fetchEpss(ids);
  assert.equal(capture.calls.length, 2);
  assert.ok(
    capture.calls.every((c) => c.url.startsWith("https://api.first.org/")),
  );
  assert.deepEqual(out.get("CVE-2026-1000"), {
    scoreBp: 1235,
    percentileBp: 9500,
  });
  assert.deepEqual(out.get("CVE-2026-1001"), {
    scoreBp: 4,
    percentileBp: 9500,
  });
  assert.equal(out.size, 150);
});

test("fetchEpss: an unreadable answer throws, so the scores kept stay", async () => {
  capture = captureFetch(() => new Response("{}", { status: 503 }));
  await assert.rejects(fetchEpss(["CVE-2026-1"]), /HTTP 503/);
});

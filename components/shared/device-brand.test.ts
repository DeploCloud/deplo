import { test } from "node:test";
import assert from "node:assert/strict";

import { describeUserAgent } from "@/lib/user-agent";
import { BROWSER_BRAND, OS_BRAND } from "./device-brand";

/**
 * The map and the parser have to stay in step: the day `user-agent.ts` learns a
 * browser this file has never heard of, the row silently loses its mark. These
 * are real user agents, so the check is on the pair, not on the key list.
 */

const AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Brave/120",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Vivaldi/6.5",
  "curl/8.4.0",
  "Wget/1.21.4",
  "PostmanRuntime/7.36.0",
  "insomnia/8.6.0",
  "python-requests/2.31.0",
  "Go-http-client/2.0",
  "node-fetch/3.3.2",
  "deplo/0.1.0",
];

test("every browser and OS the parser names has a mark", () => {
  const missing: string[] = [];
  for (const ua of AGENTS) {
    const { browser, os } = describeUserAgent(ua);
    if (browser && !BROWSER_BRAND[browser]) missing.push(`browser ${browser}`);
    if (os && !OS_BRAND[os]) missing.push(`os ${os}`);
  }
  assert.deepEqual(missing, [], `no brand entry for: ${missing.join(", ")}`);
});

test("every mark can actually be drawn", () => {
  for (const [key, b] of [
    ...Object.entries(OS_BRAND),
    ...Object.entries(BROWSER_BRAND),
  ]) {
    assert.ok(b.path || b.icon, `${key} has neither a path nor a glyph`);
    assert.ok(b.bg && b.fg, `${key} is missing a colour`);
  }
});

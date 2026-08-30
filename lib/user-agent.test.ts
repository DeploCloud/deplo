import { test } from "node:test";
import assert from "node:assert/strict";

import { describeUserAgent } from "./user-agent";

/**
 * Real User-Agent strings, because the whole difficulty of this parser is that
 * they impersonate each other: Edge says Chrome and Safari, Chrome says Safari,
 * Opera and Samsung Internet both say Chrome, Android says Linux.
 */

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91",
  operaWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0",
  samsung:
    "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
  firefoxLinux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
  firefoxIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/605.1.15",
  chromeAndroidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  chromeAndroidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  curl: "curl/8.4.0",
  node: "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
  headless:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36",
};

test("headless Chrome is named, not filed under Safari", () => {
  // `\bChrome\/` does not match "HeadlessChrome/", no word boundary after
  // "Headless", so without its own entry this fell through to the Safari rule
  // and a scripted client appeared as a browser nobody had opened.
  assert.equal(
    describeUserAgent(UA.headless).label,
    "Headless Chrome on Linux",
  );
});

test("Edge is not reported as Chrome, though its UA claims both", () => {
  assert.equal(describeUserAgent(UA.edgeWin).label, "Edge on Windows");
});

test("Opera and Samsung Internet are not reported as Chrome either", () => {
  assert.equal(describeUserAgent(UA.operaWin).label, "Opera on Windows");
  assert.equal(
    describeUserAgent(UA.samsung).label,
    "Samsung Internet on Android",
  );
});

test("Chrome is not reported as Safari, though its UA claims Safari", () => {
  assert.equal(describeUserAgent(UA.chromeMac).label, "Chrome on macOS");
  assert.equal(describeUserAgent(UA.chromeWin).label, "Chrome on Windows");
});

test("real Safari is still recognised once the impostors are excluded", () => {
  assert.equal(describeUserAgent(UA.safariMac).label, "Safari on macOS");
  assert.equal(describeUserAgent(UA.safariIphone).label, "Safari on iPhone");
});

test("the iOS re-skins are named after the browser the user chose", () => {
  // CriOS/FxiOS are WebKit underneath, but the person picked Chrome or Firefox
  // and that is the row they will recognise.
  assert.equal(describeUserAgent(UA.chromeIos).label, "Chrome on iPhone");
  assert.equal(describeUserAgent(UA.firefoxIos).label, "Firefox on iPhone");
});

test("Android is not reported as Linux, though its UA says Linux", () => {
  assert.equal(
    describeUserAgent(UA.chromeAndroidPhone).label,
    "Chrome on Android",
  );
  assert.equal(describeUserAgent(UA.firefoxLinux).label, "Firefox on Linux");
});

test("ChromeOS is not reported as Linux either", () => {
  assert.equal(describeUserAgent(UA.chromeOs).label, "Chrome on ChromeOS");
});

test("device kind separates phones from tablets from desktops", () => {
  assert.equal(describeUserAgent(UA.chromeAndroidPhone).device, "mobile");
  // Android tablets are Android WITHOUT the "Mobile" token - the only signal.
  assert.equal(describeUserAgent(UA.chromeAndroidTablet).device, "tablet");
  assert.equal(describeUserAgent(UA.safariIpad).device, "tablet");
  assert.equal(describeUserAgent(UA.safariIphone).device, "mobile");
  assert.equal(describeUserAgent(UA.chromeMac).device, "desktop");
  assert.equal(describeUserAgent(UA.chromeOs).device, "desktop");
});

test("an iPad claiming to be a Mac is still an iPad", () => {
  // iPadOS 13+ ships a desktop-Safari UA; the "Mobile" token is what remains.
  const ua =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
  const info = describeUserAgent(ua);
  assert.equal(info.os, "iPad");
  assert.equal(info.device, "tablet");
});

test("non-browser clients are named, not filed under Unknown", () => {
  assert.equal(describeUserAgent(UA.curl).label, "curl");
  assert.equal(describeUserAgent(UA.node).label, "Node");
  assert.equal(describeUserAgent("deplo-cli/1.2.0").label, "deplo CLI");
});

test("a missing or unparseable agent degrades to a plain label, never throws", () => {
  for (const ua of [null, undefined, "", "   ", "!!!"]) {
    const info = describeUserAgent(ua);
    assert.equal(info.label, "Unknown device");
    assert.equal(info.device, "unknown");
  }
});

test("an OS with no recognisable browser still names the OS", () => {
  const info = describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  assert.equal(info.label, "Windows");
  assert.equal(info.browser, null);
});

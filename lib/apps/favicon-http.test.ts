// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseIconLinks,
  rankIconLinks,
  resolveIconHref,
  iconCandidates,
  imageMimeFor,
  sniffImageMime,
  MAX_ICON_FETCHES,
} from "./favicon-http";

/**
 * The icon a RUNNING app declares about itself - the compose-stack arm, where the
 * favicon is inside a prebuilt image and is only ever served.
 */

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
]);
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 1, 0, 16, 16]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const HTML = new TextEncoder().encode(
  "<!DOCTYPE html><html><body>404</body></html>",
);
const SVG = new TextEncoder().encode(
  '<?xml version="1.0"?><svg viewBox="0 0 8 8"></svg>',
);

const paths = (html: string, opts = { basePath: "", host: "" }): string[] =>
  iconCandidates(html, opts).flatMap((c) =>
    c.kind === "path" ? [c.path] : [],
  );

test("parseIconLinks: takes icon and apple-touch-icon links, ignores everything else", () => {
  const links = parseIconLinks(`
    <html><head>
      <link rel="stylesheet" href="/app.css">
      <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
      <link rel="shortcut icon" href="/favicon.ico">
      <link rel='apple-touch-icon' sizes='180x180' href='/apple.png'>
      <link rel="mask-icon" href="/mask.svg" color="#000">
      <link rel="manifest" href="/site.webmanifest">
      <link rel="preload" as="image" href="/hero.png">
    </head><body><link rel="icon" href="/body-late.png"></body></html>`);
  assert.deepEqual(
    links.map((l) => l.href),
    ["/favicon-32.png", "/favicon.ico", "/apple.png"],
  );
  // A mask-icon is a monochrome silhouette - a black blob anywhere but Safari's
  // pinned tab, so it is never the app's real icon.
  assert.ok(!links.some((l) => l.href === "/mask.svg"));
  // Nothing after </head> is scanned.
  assert.ok(!links.some((l) => l.href === "/body-late.png"));
});

test("parseIconLinks: reads a link with no quotes and decodes entities in the href", () => {
  const links = parseIconLinks(
    `<head><link rel=icon href=/icon.png?v=1&amp;t=2></head>`,
  );
  assert.deepEqual(
    links.map((l) => l.href),
    ["/icon.png?v=1&t=2"],
  );
});

test("rankIconLinks: format first, then declared size", () => {
  const links = parseIconLinks(`<head>
      <link rel="icon" href="/favicon.ico">
      <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
      <link rel="icon" sizes="32x32" href="/small.png">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
    </head>`);
  assert.deepEqual(
    rankIconLinks(links).map((l) => l.href),
    // SVG scales, so it wins outright; between the two PNGs the bigger one is
    // the better app icon; the 16px multi-res ICO ranks last.
    ["/icon.svg", "/apple.png", "/small.png", "/favicon.ico"],
  );
});

test("iconCandidates: always ends with the /favicon.ico fallback, deduped and capped", () => {
  assert.deepEqual(paths("<head></head>"), ["/favicon.ico"]);
  // An API that serves no HTML at all still gets the well-known path tried.
  assert.deepEqual(paths(""), ["/favicon.ico"]);
  // A page that already declares /favicon.ico doesn't get it twice.
  assert.deepEqual(
    paths(`<head><link rel="icon" href="/favicon.ico"></head>`),
    ["/favicon.ico"],
  );
  const many = Array.from(
    { length: 10 },
    (_, i) => `<link rel="icon" href="/i${i}.png" sizes="${64 - i}x${64 - i}">`,
  ).join("");
  assert.equal(paths(`<head>${many}</head>`).length, MAX_ICON_FETCHES);
});

test("resolveIconHref: relative hrefs resolve against the path the app is served on", () => {
  assert.deepEqual(
    resolveIconHref("/favicon.ico", { basePath: "", host: "" }),
    {
      kind: "path",
      path: "/favicon.ico",
    },
  );
  assert.deepEqual(resolveIconHref("favicon.ico", { basePath: "", host: "" }), {
    kind: "path",
    path: "/favicon.ico",
  });
  // An app routed on /api that does NOT strip the prefix sees it in every URL.
  assert.deepEqual(
    resolveIconHref("./icon.png", { basePath: "/api", host: "" }),
    {
      kind: "path",
      path: "/api/icon.png",
    },
  );
});

test("resolveIconHref: an absolute URL is kept only when it points back at this app", () => {
  const opts = { basePath: "", host: "app.example.com" };
  assert.deepEqual(resolveIconHref("https://app.example.com/i.png", opts), {
    kind: "path",
    path: "/i.png",
  });
  // A CDN is a different origin: the agent reaches this app's container and
  // nothing else, which is exactly what keeps it from being a general fetch.
  assert.equal(resolveIconHref("https://cdn.example.net/i.png", opts), null);
  assert.equal(resolveIconHref("//cdn.example.net/i.png", opts), null);
  assert.equal(resolveIconHref("javascript:alert(1)", opts), null);
  assert.equal(resolveIconHref("", opts), null);
});

test("resolveIconHref: refuses a path the agent would reject as smuggling", () => {
  const opts = { basePath: "", host: "" };
  assert.equal(resolveIconHref("/a\r\nX-Injected: 1", opts), null);
  assert.equal(resolveIconHref("/a\nb", opts), null);
  // A space is legal in an href and is encoded rather than dropped.
  assert.deepEqual(resolveIconHref("/my icon.png", opts), {
    kind: "path",
    path: "/my%20icon.png",
  });
});

test("resolveIconHref: an inlined data: icon needs no request at all", () => {
  const base64 = resolveIconHref(
    `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
    { basePath: "", host: "" },
  );
  assert.equal(base64?.kind, "inline");
  assert.equal(base64?.kind === "inline" && base64.mime, "image/png");
  assert.deepEqual(
    base64?.kind === "inline" && Array.from(base64.bytes),
    Array.from(PNG),
  );
  // The percent-encoded form real sites use for inline SVGs.
  const svg = resolveIconHref("data:image/svg+xml,%3Csvg%3E%3C/svg%3E", {
    basePath: "",
    host: "",
  });
  assert.equal(svg?.kind === "inline" && svg.mime, "image/svg+xml");
  // Not an image type we can store.
  assert.equal(
    resolveIconHref("data:text/html,<b>x</b>", { basePath: "", host: "" }),
    null,
  );
});

test("sniffImageMime: recognises the formats a favicon actually comes in", () => {
  assert.equal(sniffImageMime(PNG), "image/png");
  assert.equal(sniffImageMime(ICO), "image/x-icon");
  assert.equal(sniffImageMime(GIF), "image/gif");
  assert.equal(sniffImageMime(JPEG), "image/jpeg");
  const webp = new Uint8Array(16);
  webp.set([0x52, 0x49, 0x46, 0x46], 0);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(sniffImageMime(webp), "image/webp");
  assert.equal(sniffImageMime(HTML), null);
});

test("imageMimeFor: the BYTES decide, not the header", () => {
  // An SPA answering /favicon.ico with index.html - a 200, even a plausible
  // content type. Storing that would render a broken image on every page.
  assert.equal(imageMimeFor(HTML, "image/x-icon", "/favicon.ico"), null);
  assert.equal(
    imageMimeFor(HTML, "text/html; charset=utf-8", "/favicon.ico"),
    null,
  );
  // A real image with a useless content type is still recognised.
  assert.equal(
    imageMimeFor(PNG, "application/octet-stream", "/icon"),
    "image/png",
  );
  // Content type disagreeing with the bytes: the bytes win.
  assert.equal(imageMimeFor(PNG, "image/gif", "/icon.gif"), "image/png");
});

test("imageMimeFor: SVG has no magic number, so it is read", () => {
  assert.equal(
    imageMimeFor(SVG, "image/svg+xml", "/icon.svg"),
    "image/svg+xml",
  );
  assert.equal(imageMimeFor(SVG, "", "/icon.svg"), "image/svg+xml");
  // Declared SVG that is really an HTML error page.
  assert.equal(imageMimeFor(HTML, "image/svg+xml", "/icon.svg"), null);
});

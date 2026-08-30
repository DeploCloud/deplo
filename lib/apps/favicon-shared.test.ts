import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mimeForFaviconPath,
  scoreFaviconPath,
  pickBestFavicon,
  faviconSourceKind,
} from "./favicon-shared";
import { MAX_LOGO_BYTES } from "./logo-shared";

test("mimeForFaviconPath: maps supported extensions incl. .ico", () => {
  assert.equal(mimeForFaviconPath("public/favicon.svg"), "image/svg+xml");
  assert.equal(mimeForFaviconPath("favicon.PNG"), "image/png");
  assert.equal(mimeForFaviconPath("favicon.ico"), "image/x-icon");
  assert.equal(mimeForFaviconPath("favicon.jpg"), "image/jpeg");
  assert.equal(mimeForFaviconPath("favicon.webp"), "image/webp");
  assert.equal(mimeForFaviconPath("README.md"), null);
  assert.equal(mimeForFaviconPath("noext"), null);
});

test("scoreFaviconPath: ONLY files named `favicon` are candidates", () => {
  // Accepted: `favicon` (any supported ext), plus size/variant suffixes.
  assert.notEqual(scoreFaviconPath("public/favicon.svg"), null);
  assert.notEqual(scoreFaviconPath("favicon.ico"), null);
  assert.notEqual(scoreFaviconPath("public/favicon.png"), null);
  assert.notEqual(scoreFaviconPath("public/favicon-32x32.png"), null);
  // Rejected: everything NOT named favicon - logo, icon, apple-touch-icon, …
  assert.equal(scoreFaviconPath("logo.svg"), null);
  assert.equal(scoreFaviconPath("public/logo.png"), null);
  assert.equal(scoreFaviconPath("app/icon.svg"), null);
  assert.equal(scoreFaviconPath("public/icon-512.png"), null);
  assert.equal(scoreFaviconPath("apple-touch-icon.png"), null);
  assert.equal(scoreFaviconPath("android-chrome-192x192.png"), null);
  assert.equal(scoreFaviconPath("public/hero-banner.png"), null);
  assert.equal(scoreFaviconPath("src/index.ts"), null);
});

test("scoreFaviconPath: rejects favicons under excluded directories", () => {
  assert.equal(scoreFaviconPath("node_modules/pkg/favicon.svg"), null);
  assert.equal(scoreFaviconPath("vendor/lib/favicon.png"), null);
  assert.equal(scoreFaviconPath("examples/demo/public/favicon.png"), null);
  assert.equal(scoreFaviconPath("dist/favicon.ico"), null);
});

test("pickBestFavicon: extension order svg > png > ico for the same name", () => {
  assert.equal(
    pickBestFavicon([
      { path: "public/favicon.png", size: 1000 },
      { path: "public/favicon.svg", size: 1000 },
      { path: "public/favicon.ico", size: 1000 },
    ])?.path,
    "public/favicon.svg",
  );
  assert.equal(
    pickBestFavicon([
      { path: "public/favicon.ico", size: 1000 },
      { path: "public/favicon.png", size: 1000 },
    ])?.path,
    "public/favicon.png",
  );
});

test("pickBestFavicon: a bare favicon.ico IS picked when it's the only one", () => {
  assert.equal(
    pickBestFavicon([
      { path: "public/logo.svg", size: 1000 }, // not a favicon → ignored
      { path: "favicon.ico", size: 1000 },
    ])?.path,
    "favicon.ico",
  );
});

test("pickBestFavicon: prefers public/ over a deep buried favicon", () => {
  assert.equal(
    pickBestFavicon([
      { path: "public/favicon.svg", size: 1000 },
      { path: "src/a/b/c/d/favicon.svg", size: 1000 },
    ])?.path,
    "public/favicon.svg",
  );
});

test("pickBestFavicon: drops candidates over the logo size cap", () => {
  assert.equal(
    pickBestFavicon([
      { path: "public/favicon.svg", size: MAX_LOGO_BYTES + 1 },
      { path: "public/favicon.png", size: 2000 },
    ])?.path,
    "public/favicon.png",
  );
});

test("pickBestFavicon: honours the build rootDirectory in a monorepo", () => {
  const files = [
    { path: "apps/web/public/favicon.svg", size: 1000 },
    { path: "apps/admin/public/favicon.svg", size: 1000 },
  ];
  assert.equal(
    pickBestFavicon(files, { rootRel: "apps/admin" })?.path,
    "apps/admin/public/favicon.svg",
  );
  assert.equal(
    pickBestFavicon(files, { rootRel: "apps/web" })?.path,
    "apps/web/public/favicon.svg",
  );
});

test("pickBestFavicon: returns null when there is no favicon", () => {
  assert.equal(
    pickBestFavicon([
      { path: "public/logo.svg", size: 100 },
      { path: "app/icon.svg", size: 100 },
      { path: "src/index.ts", size: 100 },
      { path: "README.md", size: 100 },
    ]),
    null,
  );
});

test("pickBestFavicon: ties break on the smaller path deterministically", () => {
  const a = pickBestFavicon([
    { path: "public/favicon-b.png", size: 1000 },
    { path: "public/favicon-a.png", size: 1000 },
  ]);
  assert.equal(a?.path, "public/favicon-a.png");
});

/* ------------------------------------------------------------------ */
/* faviconSourceKind, which pile of files an app's icon comes from     */
/* ------------------------------------------------------------------ */

const APP = {
  source: "docker-image",
  compose: null as string | null,
  repo: null as { provider?: string | null; url?: string | null } | null,
  dockerImage: null as string | null,
};

test("faviconSourceKind: a compose stack is scanned on its own server", () => {
  assert.equal(
    faviconSourceKind({
      ...APP,
      source: "compose",
      compose: "services:\n  web:\n",
    }),
    "app-files",
  );
});

test("faviconSourceKind: compose wins over a repo the app no longer builds from", () => {
  // Switching an app to a compose stack KEEPS the repo (so it can switch back),
  // but the deploy ignores it - detection must ignore it the same way.
  assert.equal(
    faviconSourceKind({
      ...APP,
      source: "compose",
      compose: "services:\n  web:\n",
      repo: { provider: "github", url: "https://github.com/acme/site" },
    }),
    "app-files",
  );
});

test("faviconSourceKind: a legacy template app (compose, no repo/image) is app-files", () => {
  assert.equal(
    faviconSourceKind({
      ...APP,
      source: "docker-image",
      compose: "services: {}",
    }),
    "app-files",
  );
});

test("faviconSourceKind: GitHub repos are read over the API", () => {
  assert.equal(
    faviconSourceKind({
      ...APP,
      source: "github",
      repo: { provider: "github", url: "https://github.com/acme/site" },
    }),
    "github",
  );
  // A bare git URL that happens to be github.com counts too.
  assert.equal(
    faviconSourceKind({
      ...APP,
      source: "git",
      repo: { provider: "git", url: "https://github.com/acme/site.git" },
    }),
    "github",
  );
});

test("faviconSourceKind: a non-GitHub git host has nothing the control plane can read", () => {
  assert.equal(
    faviconSourceKind({
      ...APP,
      source: "git",
      repo: { provider: "git", url: "https://gitlab.com/acme/site.git" },
    }),
    "none",
  );
});

test("faviconSourceKind: an upload is scanned from its archive", () => {
  assert.equal(faviconSourceKind({ ...APP, source: "upload" }), "upload");
  // Even with a stale compose lingering from a previous source - an upload is
  // explicit and still builds its archive.
  assert.equal(
    faviconSourceKind({ ...APP, source: "upload", compose: "services: {}" }),
    "upload",
  );
});

test("faviconSourceKind: a prebuilt image alone has no files to scan", () => {
  assert.equal(
    faviconSourceKind({
      ...APP,
      source: "docker-image",
      dockerImage: "nginx:latest",
    }),
    "none",
  );
});

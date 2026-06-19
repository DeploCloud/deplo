/**
 * Test-only resolver shim: make `require("server-only")` /
 * `require("client-only")` a no-op under `node --test`.
 *
 * Those packages exist solely as a bundler guard — their real entrypoint THROWS
 * so importing them in a client bundle is a build error. They are not installed
 * as standalone modules (Next provides them at build time), so a `server-only`
 * module is otherwise unimportable from a plain Node test. `tsx` transpiles the
 * TS test graph to CommonJS, so the taint surfaces as a CJS `require` — we patch
 * `Module._resolveFilename` to redirect those two specifiers to this file's
 * empty exports. Loaded via `--import` from the `test` script; production builds
 * never see it, so the real client-guard is unaffected.
 */
// This is a CommonJS preload (`node --require`), so `require` is correct here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("node:module");

const STUBBED = new Set(["server-only", "client-only"]);
const origResolve = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (STUBBED.has(request)) return __filename; // this module exports nothing
  return origResolve.call(this, request, ...rest);
};

module.exports = {};

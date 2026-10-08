// Test files mkdtemp at module load, where no test hook can own the result, so
// the worker removes every one of them on its way out. Cache dirs (pglite, tsx)
// are deterministic paths, not mkdtemp, and are never touched.
// This is a CommonJS preload (`node --require`), so `require` is correct here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");

const made = [];
const remember = (dir) => {
  if (typeof dir === "string") made.push(dir);
  return dir;
};

const { mkdtempSync, mkdtemp } = fs;
const mkdtempPromise = fs.promises.mkdtemp;

fs.mkdtempSync = (...args) => remember(mkdtempSync(...args));

fs.mkdtemp = (prefix, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  const wrapped = (err, dir) => {
    if (!err) remember(dir);
    done(err, dir);
  };
  return typeof options === "function"
    ? mkdtemp(prefix, wrapped)
    : mkdtemp(prefix, options, wrapped);
};

fs.promises.mkdtemp = async (...args) =>
  remember(await mkdtempPromise(...args));

process.on("exit", () => {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A dir the test already removed, or one outside our reach: not our problem.
    }
  }
});

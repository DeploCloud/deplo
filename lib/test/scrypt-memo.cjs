// scrypt at the production cost is most of a sign-in test, and tests verify the
// same seeded hash over and over. It is a pure function, so a repeat answers from
// memory with the same bytes; only the wait goes.
// This is a CommonJS preload (`node --require`), so `require` is correct here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("node:crypto");

const { scrypt, scryptSync } = crypto;
const memo = new Map();

function key(password, salt, keylen, o = {}) {
  const hex = (v) => Buffer.from(v).toString("hex");
  const cost = [o.N ?? o.cost, o.r ?? o.blockSize, o.p ?? o.parallelization];
  return `${hex(password)}:${hex(salt)}:${keylen}:${cost.join(",")}`;
}

crypto.scrypt = function (password, salt, keylen, options, callback) {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? undefined : options;
  const k = key(password, salt, keylen, opts);
  const hit = memo.get(k);
  if (hit) return process.nextTick(cb, null, Buffer.from(hit));
  scrypt(password, salt, keylen, opts ?? {}, (err, derived) => {
    if (!err) memo.set(k, Buffer.from(derived));
    cb(err, derived);
  });
};

crypto.scryptSync = function (password, salt, keylen, options) {
  const k = key(password, salt, keylen, options);
  if (!memo.has(k))
    memo.set(k, Buffer.from(scryptSync(password, salt, keylen, options)));
  return Buffer.from(memo.get(k));
};

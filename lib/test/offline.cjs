// Tests never leave the machine: a connection to anything but loopback is refused
// at once, so a fixture's fake agent address fails like a dead host instead of
// waiting out a dial timeout, and no test can lean on the internet.
// This is a CommonJS preload (`node --require`), so `require` is correct here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("node:net");

const connect = net.Socket.prototype.connect;

function target(args) {
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (typeof first === "object" && first !== null) return first;
  if (typeof first === "string" && Number.isNaN(Number(first)))
    return { path: first };
  return { port: first, host: typeof second === "string" ? second : undefined };
}

function isLoopback(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "::" ||
    h === "0.0.0.0" ||
    /^(::ffff:)?127\./.test(h)
  );
}

net.Socket.prototype.connect = function (...args) {
  const { path, host = "localhost", port } = target(args);
  if (path || isLoopback(String(host))) return connect.apply(this, args);
  const err = Object.assign(
    new Error(`connect ECONNREFUSED ${host}:${port} (tests run offline)`),
    {
      code: "ECONNREFUSED",
      errno: -111,
      syscall: "connect",
      address: host,
      port,
    },
  );
  this.connecting = true;
  process.nextTick(() => this.destroy(err));
  return this;
};

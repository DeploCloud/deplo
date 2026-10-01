import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";

import "./offline.cjs";

test("a connection off the machine is refused at once, not timed out", async () => {
  const started = Date.now();
  const err = await new Promise<NodeJS.ErrnoException>((resolve) =>
    net.connect(9443, "10.0.0.1").on("error", resolve),
  );
  assert.equal(err.code, "ECONNREFUSED");
  assert.ok(
    Date.now() - started < 1000,
    "a dead host must not wait out a timeout",
  );
  await assert.rejects(
    fetch("https://registry-1.docker.io/v2/"),
    (e: Error) => (e.cause as NodeJS.ErrnoException)?.code === "ECONNREFUSED",
  );
});

test("loopback still answers, by name and by address", async () => {
  const server = http.createServer((_, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    for (const host of ["127.0.0.1", "localhost"])
      assert.equal(await (await fetch(`http://${host}:${port}`)).text(), "ok");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

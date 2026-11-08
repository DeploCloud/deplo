import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { portProbeCommand } from "./port-probe";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

function probe(port: number, files: { tcp?: string; tcp6?: string }): number {
  const dir = mkdtempSync(join(tmpdir(), "deplo-probe-"));
  try {
    if (files.tcp !== undefined)
      writeFileSync(join(dir, "tcp"), HEADER + files.tcp);
    if (files.tcp6 !== undefined)
      writeFileSync(join(dir, "tcp6"), HEADER + files.tcp6);
    const procNet = dir.replace(/\\/g, "/");
    return (
      spawnSync("sh", ["-c", portProbeCommand(port, procNet)]).status ?? -1
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3000 = 0x0BB8, 8080 = 0x1F90. State 0A is LISTEN, 01 is ESTABLISHED.
const listen3000v4 =
  "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1\n";
const listen3000v6 =
  "   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1\n";
const connected3000 =
  "   1: 0100007F:9C40 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 2 1\n";
const listen8080 =
  "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1\n";

describe("port probe", () => {
  test("is healthy when the app listens on its port over IPv4", () => {
    assert.equal(probe(3000, { tcp: listen3000v4, tcp6: "" }), 0);
  });

  test("is healthy when the app listens on its port over IPv6 only", () => {
    assert.equal(probe(3000, { tcp: "", tcp6: listen3000v6 }), 0);
  });

  test("is unhealthy while nothing listens yet", () => {
    assert.notEqual(probe(3000, { tcp: "", tcp6: "" }), 0);
  });

  test("a connection TO the port is not a listener", () => {
    assert.notEqual(probe(3000, { tcp: connected3000, tcp6: "" }), 0);
  });

  test("a listener on another port does not count", () => {
    assert.notEqual(probe(3000, { tcp: listen8080, tcp6: "" }), 0);
    assert.equal(probe(8080, { tcp: listen8080 }), 0);
  });

  test("a missing table (no IPv6 in the container) is not an error", () => {
    assert.equal(probe(3000, { tcp: listen3000v4 }), 0);
  });
});

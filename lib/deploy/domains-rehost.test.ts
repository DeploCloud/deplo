import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ipToHex,
  hexToIp,
  rehostNip,
  rehostEmbeddedNip,
  rehostBlueprintHosts,
  nipEmbeddedIp,
  panelFallbackHost,
  instanceHost,
} from "./domains";

/**
 * A template's generated nip.io hosts are baked against the MASTER's IP in the
 * /new page (the target server isn't known until submit).
 */

const MASTER = "95.135.208.208";
const REMOTE = "152.89.254.133";
// The 8-char hex of each IP, the trailing nip.io label that does the routing.
const MASTER_HEX = "5f87d0d0";
const REMOTE_HEX = "9859fe85";

test("the panel's own generated host carries this server's IP", () => {
  // KEEP IN SYNC with install.sh, which mints the same name in shell before the
  // panel is up. A different shape here and the router serves an address the
  // panel does not know it has.
  assert.equal(panelFallbackHost("1.2.3.4"), "deplo-01020304.nip.io");
  assert.equal(panelFallbackHost(MASTER), `deplo-${MASTER_HEX}.nip.io`);
  assert.equal(nipEmbeddedIp(panelFallbackHost(REMOTE)), REMOTE);
});

test("the instance reads its own IP back out of its generated address", () => {
  // After this change DEPLO_PUBLIC_URL usually IS a nip.io host, and NIC
  // detection picks whichever interface comes first on a multi-homed box.
  const prevIp = process.env.DEPLO_SERVER_IP;
  const prevUrl = process.env.DEPLO_PUBLIC_URL;
  delete process.env.DEPLO_SERVER_IP;
  process.env.DEPLO_PUBLIC_URL = `https://${panelFallbackHost(REMOTE)}`;
  try {
    assert.equal(instanceHost(), REMOTE);
  } finally {
    if (prevIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = prevIp;
    if (prevUrl === undefined) delete process.env.DEPLO_PUBLIC_URL;
    else process.env.DEPLO_PUBLIC_URL = prevUrl;
  }
});

test("ipToHex encodes an IPv4 as 8 zero-padded hex chars", () => {
  assert.equal(ipToHex(MASTER), MASTER_HEX);
  assert.equal(ipToHex(REMOTE), REMOTE_HEX);
  // Leading-zero octets stay two digits each (never collapsed).
  assert.equal(ipToHex("1.2.3.4"), "01020304");
  assert.equal(ipToHex("127.0.0.1"), "7f000001");
  assert.equal(ipToHex("0.0.0.0"), "00000000");
  assert.equal(ipToHex("255.255.255.255"), "ffffffff");
});

test("hexToIp is the inverse of ipToHex, and rejects non-hex / bad width", () => {
  assert.equal(hexToIp(MASTER_HEX), MASTER);
  assert.equal(hexToIp("01020304"), "1.2.3.4");
  assert.equal(hexToIp("7f000001"), "127.0.0.1");
  // Not 8 hex digits → null.
  assert.equal(hexToIp("1020304"), null);
  assert.equal(hexToIp("zzzzzzzz"), null);
  assert.equal(hexToIp(""), null);
});

test("nipEmbeddedIp extracts the embedded IPv4 (and only an anchored nip host)", () => {
  assert.equal(
    nipEmbeddedIp(`garage-charming-otter-${MASTER_HEX}.nip.io`),
    MASTER,
  );
  assert.equal(
    nipEmbeddedIp(`web-ui-garage-bold-lynx-${MASTER_HEX}.nip.io`),
    MASTER,
  );
  assert.equal(nipEmbeddedIp("garage.example.com"), null);
  // Not anchored at the end (trailing path) → not a bare host, so null.
  assert.equal(
    nipEmbeddedIp(`https://garage-x-y-${MASTER_HEX}.nip.io/x`),
    null,
  );
  // The random words are never mistaken for the hex IP (they aren't 8 hex
  // digits hanging off the trailing `-`).
  assert.equal(nipEmbeddedIp("garage-charming-otter.nip.io"), null);
});

test("rehostNip swaps only the hex IP, preserving the words", () => {
  assert.equal(
    rehostNip(`garage-s3-charming-otter-${MASTER_HEX}.nip.io`, REMOTE),
    `garage-s3-charming-otter-${REMOTE_HEX}.nip.io`,
  );
});

test("rehostNip moves a web-ui.* extra (exposes[].host) to the remote IP", () => {
  assert.equal(
    rehostNip(`web-ui-garage-bold-lynx-${MASTER_HEX}.nip.io`, REMOTE),
    `web-ui-garage-bold-lynx-${REMOTE_HEX}.nip.io`,
  );
});

test("rehostNip is a no-op for a non-nip host", () => {
  assert.equal(rehostNip("garage.example.com", REMOTE), "garage.example.com");
});

test("rehostEmbeddedNip rewrites the host inside a free-text env value, keeping surrounding text", () => {
  assert.equal(
    rehostEmbeddedNip(
      `https://garage-keen-puma-${MASTER_HEX}.nip.io/health`,
      MASTER,
      REMOTE,
    ),
    `https://garage-keen-puma-${REMOTE_HEX}.nip.io/health`,
  );
});

test("rehostEmbeddedNip rewrites every occurrence in one value", () => {
  const v = `A=http://a-x-y-${MASTER_HEX}.nip.io B=http://b-x-y-${MASTER_HEX}.nip.io`;
  assert.equal(
    rehostEmbeddedNip(v, MASTER, REMOTE),
    `A=http://a-x-y-${REMOTE_HEX}.nip.io B=http://b-x-y-${REMOTE_HEX}.nip.io`,
  );
});

test("rehostEmbeddedNip only touches the matching fromIp (leaves other nip hosts alone)", () => {
  const otherHex = ipToHex("10.0.0.9");
  assert.equal(
    rehostEmbeddedNip(`x-a-b-${otherHex}.nip.io`, MASTER, REMOTE),
    `x-a-b-${otherHex}.nip.io`,
  );
});

test("rehostEmbeddedNip is a no-op when the value has no nip host", () => {
  // garage's real env uses internal service DNS, never the public host - untouched.
  assert.equal(
    rehostEmbeddedNip("http://garage:3900", MASTER, REMOTE),
    "http://garage:3900",
  );
});

test("rehostBlueprintHosts moves the whole garage-with-ui blueprint to the remote IP", () => {
  // What the /new page bakes for garage-with-ui against the master IP: a primary
  // autoDomain (the apex `garage` service) + one EXTRA domain (the web UI).
  const baked = {
    autoDomain: `garage-s3-charming-otter-${MASTER_HEX}.nip.io`,
    extraDomains: [
      {
        service: "garage-webui",
        port: 3909,
        host: `web-ui-garage-bold-lynx-${MASTER_HEX}.nip.io`,
      },
    ],
    // garage's env uses internal DNS, so it should pass through untouched; add a
    // synthetic public-host env to prove that case is rewritten too.
    env: [
      { key: "S3_ENDPOINT_URL", value: "http://garage:3900" },
      {
        key: "PUBLIC_URL",
        value: `https://garage-s3-charming-otter-${MASTER_HEX}.nip.io`,
      },
    ],
  };
  const moved = rehostBlueprintHosts(baked, MASTER, REMOTE);
  assert.equal(
    moved.autoDomain,
    `garage-s3-charming-otter-${REMOTE_HEX}.nip.io`,
  );
  assert.deepEqual(moved.extraDomains, [
    {
      service: "garage-webui",
      port: 3909,
      host: `web-ui-garage-bold-lynx-${REMOTE_HEX}.nip.io`,
    },
  ]);
  assert.deepEqual(moved.env, [
    { key: "S3_ENDPOINT_URL", value: "http://garage:3900" },
    {
      key: "PUBLIC_URL",
      value: `https://garage-s3-charming-otter-${REMOTE_HEX}.nip.io`,
    },
  ]);
});

test("rehostBlueprintHosts is a no-op when the project targets the master (same IP)", () => {
  const baked = {
    autoDomain: `app-warm-finch-${MASTER_HEX}.nip.io`,
    extraDomains: [
      {
        service: "ui",
        port: 3000,
        host: `ui-app-warm-finch-${MASTER_HEX}.nip.io`,
      },
    ],
    env: [{ key: "X", value: "1" }],
  };
  // Same fromIp/toIp ⇒ the exact input is returned (callers can call blindly).
  assert.equal(rehostBlueprintHosts(baked, MASTER, MASTER), baked);
});

test("rehostBlueprintHosts does not mutate its input", () => {
  const baked = {
    autoDomain: `app-warm-finch-${MASTER_HEX}.nip.io`,
    extraDomains: [
      {
        service: "ui",
        port: 3000,
        host: `ui-app-warm-finch-${MASTER_HEX}.nip.io`,
      },
    ],
    env: [{ key: "X", value: `http://app-warm-finch-${MASTER_HEX}.nip.io` }],
  };
  const moved = rehostBlueprintHosts(baked, MASTER, REMOTE);
  assert.notEqual(moved, baked);
  assert.equal(
    baked.autoDomain,
    `app-warm-finch-${MASTER_HEX}.nip.io`,
    "input.autoDomain untouched",
  );
  assert.equal(
    baked.extraDomains[0].host,
    `ui-app-warm-finch-${MASTER_HEX}.nip.io`,
    "input.extraDomains untouched",
  );
  assert.equal(
    baked.env[0].value,
    `http://app-warm-finch-${MASTER_HEX}.nip.io`,
    "input.env untouched",
  );
});

test("rehostBlueprintHosts handles a project with no blueprint fields", () => {
  const moved = rehostBlueprintHosts(
    { autoDomain: null, extraDomains: null },
    MASTER,
    REMOTE,
  );
  assert.equal(moved.autoDomain, null);
  assert.equal(moved.extraDomains, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ipToHex,
  hexToIp,
  rehostWildcard,
  rehostEmbeddedWildcard,
  rehostBlueprintHosts,
  wildcardEmbeddedIp,
  panelFallbackHost,
  instanceHost,
  ipLabel,
  isWildcardIp,
  randomWord,
  wildcardDomain,
} from "./domains";

const MASTER = "95.135.208.208";
const REMOTE = "152.89.254.133";
const MASTER_HEX = "5f87d0d0";
const REMOTE_HEX = "9859fe85";

test("the panel's own generated host carries this server's IP", () => {
  assert.equal(panelFallbackHost("1.2.3.4"), "deplo-01020304.deplo.site");
  assert.equal(panelFallbackHost(MASTER), `deplo-${MASTER_HEX}.deplo.site`);
  assert.equal(wildcardEmbeddedIp(panelFallbackHost(REMOTE)), REMOTE);
});

test("the instance reads its own IP back out of its generated address", () => {
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
  assert.equal(ipToHex("1.2.3.4"), "01020304");
  assert.equal(ipToHex("127.0.0.1"), "7f000001");
  assert.equal(ipToHex("0.0.0.0"), "00000000");
  assert.equal(ipToHex("255.255.255.255"), "ffffffff");
});

test("hexToIp is the inverse of ipToHex, and rejects non-hex / bad width", () => {
  assert.equal(hexToIp(MASTER_HEX), MASTER);
  assert.equal(hexToIp("01020304"), "1.2.3.4");
  assert.equal(hexToIp("7f000001"), "127.0.0.1");
  assert.equal(hexToIp("1020304"), null);
  assert.equal(hexToIp("zzzzzzzz"), null);
  assert.equal(hexToIp(""), null);
});

test("wildcardEmbeddedIp extracts the embedded IPv4 (and only an anchored generated host)", () => {
  assert.equal(
    wildcardEmbeddedIp(`garage-otter-${MASTER_HEX}.deplo.site`),
    MASTER,
  );
  assert.equal(
    wildcardEmbeddedIp(`garage-charming-otter-${MASTER_HEX}.nip.io`),
    MASTER,
    "a name minted before deplo.site still reads",
  );
  assert.equal(
    wildcardEmbeddedIp(`web-ui-garage-bold-lynx-${MASTER_HEX}.nip.io`),
    MASTER,
  );
  assert.equal(wildcardEmbeddedIp("garage.example.com"), null);
  assert.equal(
    wildcardEmbeddedIp(`https://garage-x-y-${MASTER_HEX}.nip.io/x`),
    null,
  );
  assert.equal(wildcardEmbeddedIp("garage-charming-otter.nip.io"), null);
});

test("rehostWildcard swaps only the hex IP, preserving the words", () => {
  assert.equal(
    rehostWildcard(`garage-s3-otter-${MASTER_HEX}.deplo.site`, REMOTE),
    `garage-s3-otter-${REMOTE_HEX}.deplo.site`,
  );
});

test("rehostWildcard keeps a legacy host in its own zone", () => {
  assert.equal(
    rehostWildcard(`garage-s3-charming-otter-${MASTER_HEX}.nip.io`, REMOTE),
    `garage-s3-charming-otter-${REMOTE_HEX}.nip.io`,
    "moving a server must not move an app onto another zone",
  );
  assert.equal(
    rehostWildcard(`old-app-${MASTER_HEX}.sslip.io`, REMOTE),
    `old-app-${REMOTE_HEX}.sslip.io`,
  );
});

test("rehostWildcard moves a web-ui.* extra (exposes[].host) to the remote IP", () => {
  assert.equal(
    rehostWildcard(`web-ui-garage-bold-lynx-${MASTER_HEX}.nip.io`, REMOTE),
    `web-ui-garage-bold-lynx-${REMOTE_HEX}.nip.io`,
  );
});

test("rehostWildcard is a no-op for a host outside the wildcard zones", () => {
  assert.equal(
    rehostWildcard("garage.example.com", REMOTE),
    "garage.example.com",
  );
});

test("rehostEmbeddedWildcard rewrites the host inside a free-text env value, keeping surrounding text", () => {
  assert.equal(
    rehostEmbeddedWildcard(
      `https://garage-keen-puma-${MASTER_HEX}.nip.io/health`,
      MASTER,
      REMOTE,
    ),
    `https://garage-keen-puma-${REMOTE_HEX}.nip.io/health`,
  );
});

test("rehostEmbeddedWildcard rewrites every occurrence in one value", () => {
  const v = `A=http://a-x-y-${MASTER_HEX}.nip.io B=http://b-x-y-${MASTER_HEX}.nip.io`;
  assert.equal(
    rehostEmbeddedWildcard(v, MASTER, REMOTE),
    `A=http://a-x-y-${REMOTE_HEX}.nip.io B=http://b-x-y-${REMOTE_HEX}.nip.io`,
  );
});

test("rehostEmbeddedWildcard only touches the matching fromIp (leaves other generated hosts alone)", () => {
  const otherHex = ipToHex("10.0.0.9");
  assert.equal(
    rehostEmbeddedWildcard(`x-a-b-${otherHex}.nip.io`, MASTER, REMOTE),
    `x-a-b-${otherHex}.nip.io`,
  );
});

test("rehostEmbeddedWildcard is a no-op when the value has no generated host", () => {
  assert.equal(
    rehostEmbeddedWildcard("http://garage:3900", MASTER, REMOTE),
    "http://garage:3900",
  );
});

test("rehostBlueprintHosts moves the whole garage-with-ui blueprint to the remote IP", () => {
  const baked = {
    autoDomain: `garage-s3-charming-otter-${MASTER_HEX}.nip.io`,
    extraDomains: [
      {
        service: "garage-webui",
        port: 3909,
        host: `web-ui-garage-bold-lynx-${MASTER_HEX}.nip.io`,
      },
    ],
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

test("rehostBlueprintHosts drops the minted hosts when the target's IPv4 is unknown, rather than leave them on this machine", () => {
  const baked = {
    autoDomain: `app-warm-finch-${MASTER_HEX}.nip.io`,
    extraDomains: [
      { service: "ui", port: 80, host: `ui-bold-lynx-${MASTER_HEX}.nip.io` },
      { service: "api", port: 81, host: "api.example.com" },
    ],
    env: [{ key: "URL", value: `https://app-warm-finch-${MASTER_HEX}.nip.io` }],
  };
  const moved = rehostBlueprintHosts(baked, MASTER, null);
  assert.equal(moved.autoDomain, null);
  assert.deepEqual(moved.extraDomains, [
    { service: "api", port: 81, host: "api.example.com" },
  ]);
  assert.deepEqual(moved.env, baked.env);
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

const V6 = "2a12:bec4:1821:7cf::a";
const V6_LABEL = "v6-2a12-bec4-1821-7cf--a";

test("an IPv6 rides behind a v6- marker, so a hex-looking word never joins the address", () => {
  assert.equal(ipLabel(V6), V6_LABEL);
  assert.equal(ipLabel("2A12:BEC4:1821:07CF:0:0:0:A"), V6_LABEL);
  assert.equal(ipLabel(MASTER), MASTER_HEX);
  assert.equal(panelFallbackHost(V6), `deplo-${V6_LABEL}.deplo.site`);
  assert.equal(wildcardEmbeddedIp(`cafe-bad-${V6_LABEL}.deplo.site`), V6);
});

test("an IPv6 that would compress at either end is spelled out, since a label cannot end in a dash", () => {
  assert.equal(ipLabel("2a12:bec4::"), "v6-2a12-bec4-0-0-0-0-0-0");
  assert.equal(
    wildcardEmbeddedIp("x-v6-2a12-bec4-0-0-0-0-0-0.deplo.site"),
    "2a12:bec4::",
  );
});

test("only a routable IPv6 is read back out of a name", () => {
  assert.equal(wildcardEmbeddedIp("x-v6-fd00--1.deplo.site"), null);
  assert.equal(wildcardEmbeddedIp("x-v6-fe80--1.deplo.site"), null);
  assert.equal(wildcardEmbeddedIp("x-v6-zz.deplo.site"), null);
  assert.equal(isWildcardIp(V6), true);
  assert.equal(isWildcardIp("fd00::1"), false);
  assert.equal(isWildcardIp("::1"), false);
  assert.equal(isWildcardIp(MASTER), true);
});

test("a generated name moves between an IPv4 and an IPv6 and back, keeping its words", () => {
  const v4 = `web-calm-fox-${MASTER_HEX}.deplo.site`;
  const v6 = rehostWildcard(v4, V6);
  assert.equal(v6, `web-calm-fox-${V6_LABEL}.deplo.site`);
  assert.equal(rehostWildcard(v6, MASTER), v4);
  assert.equal(
    rehostEmbeddedWildcard(`https://${v6}/x`, V6, REMOTE),
    `https://web-calm-fox-${REMOTE_HEX}.deplo.site/x`,
  );
  assert.equal(
    rehostEmbeddedWildcard(`https://${v6}/x`, MASTER, REMOTE),
    `https://${v6}/x`,
  );
});

test("a name generated for an IPv6 stays one DNS label", () => {
  for (let i = 0; i < 50; i++) {
    const name = wildcardDomain(
      "a-very-long-application-slug-that-goes-on",
      `${randomWord()}-${randomWord()}-${randomWord()}`,
      "2a12:bec4:1821:7cf:1234:5678:9abc:def0",
    );
    const label = name.slice(0, -".deplo.site".length);
    assert.ok(label.length <= 63, `${label} is ${label.length} characters`);
    assert.ok(!label.endsWith("-") && !label.startsWith("-"), label);
    assert.equal(
      wildcardEmbeddedIp(name),
      "2a12:bec4:1821:7cf:1234:5678:9abc:def0",
    );
  }
});

test("an IPv6 instance reads its own address from DEPLO_SERVER_IP or its generated host", () => {
  const prevIp = process.env.DEPLO_SERVER_IP;
  const prevUrl = process.env.DEPLO_PUBLIC_URL;
  try {
    process.env.DEPLO_SERVER_IP = "2A12:BEC4:1821:7CF::A";
    assert.equal(instanceHost(), V6);
    delete process.env.DEPLO_SERVER_IP;
    process.env.DEPLO_PUBLIC_URL = `https://${panelFallbackHost(V6)}`;
    assert.equal(instanceHost(), V6);
  } finally {
    if (prevIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = prevIp;
    if (prevUrl === undefined) delete process.env.DEPLO_PUBLIC_URL;
    else process.env.DEPLO_PUBLIC_URL = prevUrl;
  }
});

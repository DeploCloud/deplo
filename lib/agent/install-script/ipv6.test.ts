import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ipLabel } from "../../deploy/domains";
import { bash, shellFn } from "./install-script-test-helpers";

const read = (file: string) => readFile(join(process.cwd(), file), "utf8");

function ipv6Block(script: string): string {
  const start = script.indexOf("# ==== Deplo IPv6 ");
  const end = script.indexOf("# ==== end Deplo IPv6 ");
  assert.ok(start >= 0 && end > start, "IPv6 block not found in installer");
  return script.slice(start, end);
}

test("both installers carry the SAME IPv6 block", async () => {
  assert.equal(
    ipv6Block(await read("install.sh")),
    ipv6Block(await read("install-agent.sh")),
    "install.sh and install-agent.sh have drifted - the IPv6 block must stay identical",
  );
});

test("Docker gets IPv6 after the address pools and before the Deplo network exists", async () => {
  for (const file of ["install.sh", "install-agent.sh"]) {
    const script = await read(file);
    const body = script.slice(script.indexOf("# ==== end Deplo IPv6 "));
    const pools = body.search(/^[ \t]*configure_docker_address_pools$/m);
    const ipv6 = body.search(/^[ \t]*configure_docker_ipv6$/m);
    const network = body.search(
      /docker network create \$\(ipv6_net_flag\) deplo/,
    );
    const moved = body.search(/^[ \t]*ensure_networks_ipv6$/m);
    assert.ok(pools > 0 && ipv6 > pools, `${file}: IPv6 must follow the pools`);
    assert.ok(
      network > ipv6,
      `${file}: the Deplo network is created before Docker has IPv6`,
    );
    assert.ok(
      moved > network,
      `${file}: existing networks are never moved onto IPv6`,
    );
  }
});

test("the installer spells an address exactly as the panel does", async () => {
  const fn = await shellFn("install.sh", "ip_label");
  const hex = await shellFn("install.sh", "ip_hex");
  const cases = [
    "95.135.208.196",
    "2a12:bec4:1821:7cf::a",
    "2001:db8::1",
    "2001:db8:0:0:1:0:0:1",
    "2a12:bec4::",
    "2a12:0:0:1:0:0:0:0",
    "2A12:BEC4:1821:07CF:0000:0000:0000:000A",
    "2a12:bec4:1821:7cf:1234:5678:9abc:def0",
  ];
  const out = await bash(
    `set -euo pipefail\n${hex}\n${fn}\nfor a in ${cases.join(" ")}; do ip_label "$a"; echo; done`,
  );
  assert.deepEqual(out.trim().split("\n"), cases.map(ipLabel));
});

test("a string that is not an IPv6 is not given a label", async () => {
  const fn = await shellFn("install.sh", "ip_label");
  const hex = await shellFn("install.sh", "ip_hex");
  for (const bad of [
    "1:2:3",
    "2a12::bec4::1",
    "2a12:zzzz::1",
    "1:2:3:4:5:6:7:8:9",
  ]) {
    const out = await bash(
      `${hex}\n${fn}\nip_label "${bad}" >/dev/null && echo yes || echo no`,
    );
    assert.equal(out.trim(), "no", `${bad} was labelled`);
  }
});

async function family(opts: { v4: boolean; v6: boolean; ask?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "deplo-ip-"));
  const route = (a: string) => `echo "x via y dev eth0 src ${a} uid 0"`;
  await writeFile(
    join(dir, "ip"),
    `#!/bin/sh
case "$1" in
  -4) ${opts.v4 ? route("203.0.113.7") : "exit 2"} ;;
  -6) ${opts.v6 ? route("2001:DB8::7") : "exit 2"} ;;
esac
`,
    { mode: 0o755 },
  );
  try {
    const block = ipv6Block(await read("install.sh"));
    const out = await bash(
      `set -uo pipefail\n${block}\nIP_FAMILY="${opts.ask ?? ""}"\nif resolve_ip_family; then r=ok; else r=refused; fi\necho "$r $IP_FAMILY $IPV6_ONLY [$HOST_V4] [$HOST_V6]"`,
      dir,
    );
    return out.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("IPv4 is the default whenever the server has one, and an IPv6-only one gets IPv6", async () => {
  assert.equal(
    await family({ v4: true, v6: true }),
    "ok ipv4 false [203.0.113.7] [2001:db8::7]",
  );
  assert.equal(
    await family({ v4: false, v6: true }),
    "ok ipv6 true [] [2001:db8::7]",
  );
  assert.equal(
    await family({ v4: true, v6: false }),
    "ok ipv4 false [203.0.113.7] []",
  );
});

test("--ipv6 picks IPv6 on a dual-stack server, and a kind the server lacks is refused", async () => {
  assert.equal(
    await family({ v4: true, v6: true, ask: "ipv6" }),
    "ok ipv6 false [203.0.113.7] [2001:db8::7]",
  );
  assert.match(await family({ v4: true, v6: false, ask: "ipv6" }), /^refused/);
  assert.match(await family({ v4: false, v6: true, ask: "ipv4" }), /^refused/);
});

test("a server with IPv4 never has its DNS touched for NAT64", async () => {
  const block = ipv6Block(await read("install.sh"));
  const out = await bash(
    `set -euo pipefail\nexec 9>/dev/null\n${block}\nIPV6_ONLY=false\nwrite_nat64_dns() { echo TOUCHED; }\nensure_nat64\necho done`,
  );
  assert.equal(out.trim(), "done");
});

test("Docker is left alone unless this install serves on IPv6", async () => {
  const block = ipv6Block(await read("install.sh"));
  const out = await bash(
    `set -euo pipefail\nexec 9>/dev/null\n${block}\nIP_FAMILY=ipv4\ndocker() { echo DOCKER "$@"; }\nconfigure_docker_ipv6\nensure_networks_ipv6\necho "[$(ipv6_net_flag)]"`,
  );
  assert.equal(out.trim(), "[]");
});

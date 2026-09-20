import { test } from "node:test";
import assert from "node:assert/strict";

import { lintCompose, needsHostAccess } from "./lint";

test("a reserved service name and a network alias are warned about, not silently handled", () => {
  const diags = lintCompose(
    [
      "services:",
      "  deplo:",
      "    image: nginx:1.27",
      "  api:",
      "    image: nginx:1.27",
      "    networks:",
      "      default:",
      "        aliases:",
      "          - postgres",
    ].join("\n"),
  );
  const rules = diags.map((d) => d.rule);
  assert.ok(
    rules.includes("reserved-service-name"),
    "a service named `deplo` deploys nowhere the moment it gets a domain",
  );
  assert.ok(
    rules.includes("network-aliases-dropped"),
    "the alias is removed at render time, so saying nothing is how it goes missing",
  );
  assert.equal(
    diags
      .filter(
        (d) =>
          d.rule === "reserved-service-name" ||
          d.rule === "network-aliases-dropped",
      )
      .every((d) => d.severity === "warning"),
    true,
  );
});

test("an ordinary stack collects neither warning", () => {
  const rules = lintCompose(
    "services:\n  web:\n    image: nginx:1.27\n    networks:\n      - default\n",
  ).map((d) => d.rule);
  assert.equal(rules.includes("reserved-service-name"), false);
  assert.equal(rules.includes("network-aliases-dropped"), false);
});

test("lint: the ./ note says a missing path is created, as a file or a folder", () => {
  const diags = lintCompose(`services:
  web:
    image: nginx
    volumes:
      - ./config.yml:/app/config.yml
`);
  const note = diags.find((d) => d.rule === "bind-mount-files-note");
  assert.ok(note, "the note is emitted");
  assert.match(note.message, /creates it there if it is missing/);
  assert.match(note.message, /as a file when the name looks like one/);
});

test("a stack that reaches the server is flagged before it is deployed", () => {
  const socket = lintCompose(`services:
  kuma:
    image: louislam/uptime-kuma:2
    volumes:
      - kuma-data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
volumes:
  kuma-data:
`);
  assert.equal(needsHostAccess(socket), true);

  const privileged = lintCompose(`services:
  app:
    image: alpine:3
    privileged: true
`);
  assert.equal(needsHostAccess(privileged), true);

  const plain = lintCompose(`services:
  web:
    image: nginx:alpine
`);
  assert.equal(needsHostAccess(plain), false);
});

test("publishing 53 on every address is warned about, an explicit address is not", () => {
  const rulesFor = (entry: string) =>
    lintCompose(
      [
        "services:",
        "  dns:",
        "    image: coredns/coredns:1.11.3",
        "    ports:",
        `      - ${entry}`,
      ].join("\n"),
    ).map((d) => d.rule);

  for (const entry of ['"53:53/udp"', '"0.0.0.0:53:53"', '"53:53/tcp"']) {
    assert.ok(
      rulesFor(entry).includes("dns-port-unbound"),
      `${entry} claims 127.0.0.53 and every container stops resolving`,
    );
  }
  for (const entry of ['"203.0.113.10:53:53/udp"', '"8080:80"', '"53"']) {
    assert.ok(
      !rulesFor(entry).includes("dns-port-unbound"),
      `${entry} leaves the machine's resolver alone`,
    );
  }

  const long = (hostIp: string) =>
    lintCompose(
      [
        "services:",
        "  dns:",
        "    image: coredns/coredns:1.11.3",
        "    ports:",
        "      - target: 53",
        "        published: 53",
        "        protocol: udp",
        ...(hostIp ? [`        host_ip: "${hostIp}"`] : []),
      ].join("\n"),
    );
  for (const hostIp of ["", "::"]) {
    const hit = long(hostIp).find((d) => d.rule === "dns-port-unbound");
    assert.equal(hit?.severity, "warning", `long syntax, host_ip "${hostIp}"`);
  }
  assert.ok(
    !long("203.0.113.10").some((d) => d.rule === "dns-port-unbound"),
    "an explicit address in the long syntax is fine too",
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as yaml from "js-yaml";

import { bash, shellFn } from "./install-script-test-helpers";

// This machine's own agent links to the panel over loopback (ADR-0038), on a host port the installer picks.
const harness = async (body: string) =>
  bash(`set -euo pipefail
exec 9>/dev/null
state_get() { case "$1" in link_port) printf '%s' "\${KEPT_LINK_PORT:-}" ;; esac; }
state_set() { echo "state $1=$2"; }
port_in_use() { case " \${BUSY:-} " in *" $1 "*) return 0 ;; esac; return 1; }
ours_holds_port() { case " \${OURS:-} " in *" $1 "*) return 0 ;; esac; return 1; }
warn() { :; }; render_traefik_panel_config() { :; }
${await shellFn("install.sh", "first_free_port")}
${await shellFn("install.sh", "pick_link_port")}
${await shellFn("install.sh", "panel_ports")}
${body}`);

test("the panel and its agent link are published on loopback only", async () => {
  const out = await harness(`PANEL_PORT=3000; LINK_PORT=3101; panel_ports`);
  assert.deepEqual(
    (yaml.load(out.replace(/^ {4}/gm, "")) as { ports: string[] }).ports,
    ["127.0.0.1:3000:3000", "127.0.0.1:3101:3001"],
  );
});

test("the link port is chosen once and then kept, because this machine's agent saved it", async () => {
  assert.equal(await harness(`pick_link_port`), "3101");
  assert.equal(await harness(`BUSY="3101"; pick_link_port`), "3102");
  assert.equal(
    await harness(`KEPT_LINK_PORT=3102; BUSY="3102"; pick_link_port`),
    "3102",
    "a stranger on the kept port fails the preflight; moving would strand the agent",
  );
  assert.equal(
    await harness(`BUSY="3000 3001 3002 3003"; pick_link_port`),
    "3101",
    "never one of the ports a takeover parks the panel on",
  );
});

test("a takeover that has to move ports moves the link port with the rest, and remembers it", async () => {
  const out = await harness(`TAKEOVER=dokploy; TAKEOVER_PAST=0
PANEL_PORT=3000; HTTP_PORT=8080; HTTPS_PORT=8443; LINK_PORT=3101
BUSY="3101"
${await shellFn("install.sh", "takeover_repick_ports")}
takeover_repick_ports
printf '%s\\n' "$DEPLO_EXPOSE"`);
  assert.match(out, /^state link_port=3102$/m);
  assert.match(out, /"127\.0\.0\.1:3102:3001"/);
  assert.match(out, /"127\.0\.0\.1:3000:3000"/);
});

test("the panel is told the host port its agent link is published on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-panel-compose-"));
  await bash(`set -euo pipefail
DEPLO_DIR=${dir}; DEPLO_IMAGE=ghcr.io/deplocloud/deplo:test; PUBLIC_URL=https://x
SERVER_IP=203.0.113.7; SERVER_IPV4=203.0.113.7; SERVER_IPV6=; HOST_NAME=box
PANEL_PORT=3000; LINK_PORT=3102; TAKEOVER=
${await shellFn("install.sh", "panel_ports")}
DEPLO_EXPOSE="$(panel_ports)"
${await shellFn("install.sh", "write_panel_compose")}
write_panel_compose`);
  const compose = yaml.load(
    await readFile(join(dir, "docker-compose.yml"), "utf8"),
  ) as { services: { deplo: { environment: string[]; ports: string[] } } };
  await rm(dir, { recursive: true, force: true });
  const { environment, ports } = compose.services.deplo;
  assert.ok(environment.includes("DEPLO_LINK_PORT=3102"), String(environment));
  assert.ok(ports.includes("127.0.0.1:3102:3001"), String(ports));
});

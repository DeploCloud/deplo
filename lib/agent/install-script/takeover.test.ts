import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as yaml from "js-yaml";

import { bash, shellFn } from "./install-script-test-helpers";

test("the cutover moves the proxy and leaves the panel's container alone", async () => {
  const out = await bash(`set -euo pipefail
exec 9>/dev/null
write_traefik_compose() { echo "traefik bind=\${PROXY_BIND}\${HTTP_PORT}/\${HTTPS_PORT}"; }
write_panel_compose() { echo "PANEL REWRITTEN"; }
render_traefik_panel_config() { :; }
takeover_up_stacks() { echo up; }
${await shellFn("install.sh", "takeover_apply_ports")}
takeover_apply_ports 80 443
takeover_apply_ports 8080 8443
`);
  assert.equal(
    out,
    "traefik bind=80/443\nup\ntraefik bind=127.0.0.1:8080/8443\nup\n",
    "only the proxy is re-rendered: a panel recreated mid-cutover is the browser losing it",
  );
});

test("the removal is followed by a Docker restart, and only then is the takeover over", async () => {
  const out = await bash(`set -euo pipefail
exec 9>/dev/null
C_B=; C_OFF=; C_ACC=; PUBLIC_URL=https://x
blank() { :; }; spin_start() { :; }; spin_ok() { :; }; spin_warn() { :; }
foreign_remove() { echo foreign_remove; }
restart_docker() { echo restart_docker; }
takeover_up_stacks() { echo up; }
ensure_proxy_bound() { echo proxy_bound; }
traefik_reconnect_docker() { echo traefik_reconnect; }
wait_for_proxy() { echo "wait_for_proxy $1"; }
state_set() { echo "state $1=$2"; }
takeover_post() { echo "post $1"; }
takeover_unit_remove() { echo unit_remove; }
${await shellFn("install.sh", "takeover_after_cutover")}
takeover_after_cutover
`);
  const calls = out
    .split("\n")
    .filter((l) => l.trim() !== "" && !/^( Next|   [12]  )/.test(l));
  assert.deepEqual(calls, [
    "foreign_remove",
    "restart_docker",
    "up",
    "proxy_bound",
    "traefik_reconnect",
    "wait_for_proxy 60",
    "state takeover=removed",
    "post removed",
    "unit_remove",
  ]);
});

test("the unit runs this script as the worker and is enabled at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-unit-"));
  await writeFile(join(dir, "install.sh"), "#!/bin/bash\n", { mode: 0o700 });
  await writeFile(
    join(dir, "systemctl"),
    `#!/bin/bash\necho "$*" >> "$STUB_LOG"\n`,
    { mode: 0o755 },
  );
  const log = join(dir, "systemctl.log");
  const unit = join(dir, "unit.service");
  const out = await bash(
    `set -euo pipefail
exec 9>/dev/null
export STUB_LOG=${log}
DEPLO_DIR=${dir}; TAKEOVER_UNIT=${unit}; INSTALLER_URL=x
err() { echo "ERR $1"; }; note() { :; }
${await shellFn("install.sh", "takeover_unit_install")}
takeover_unit_install && echo installed
`,
    dir,
  );
  const text = await readFile(unit, "utf8");
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  await rm(dir, { recursive: true, force: true });
  assert.equal(out, "installed\n");
  assert.match(
    text,
    new RegExp(`ExecStart=${dir}/install.sh --takeover-worker`),
  );
  assert.match(text, /Restart=on-failure/);
  assert.match(text, /After=docker.service/);
  assert.deepEqual(calls, ["daemon-reload", "enable --now deplo-takeover"]);
});

test("the unit is refused when this script is not on the host to run later", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-unit-"));
  const out = await bash(`set -euo pipefail
exec 9>/dev/null
DEPLO_DIR=${dir}; TAKEOVER_UNIT=${dir}/unit.service; INSTALLER_URL=x
err() { echo "ERR: $1"; }; note() { :; }
${await shellFn("install.sh", "takeover_unit_install")}
takeover_unit_install || echo refused
`);
  await rm(dir, { recursive: true, force: true });
  assert.match(out, /^ERR: .*nothing can take the ports later/m);
  assert.match(out, /refused/);
});

test("the side door in the other platform's proxy lets servers link in too", async () => {
  for (const entry of ["web", "http"]) {
    const out = await bash(`set -euo pipefail
${await shellFn("install.sh", "side_door_config")}
side_door_config deplo-cb00710b.deplo.site ${entry}
`);
    const { http } = yaml.load(out) as {
      http: {
        routers: Record<
          string,
          { rule: string; entryPoints: string[]; service: string }
        >;
        services: Record<
          string,
          { loadBalancer: { servers: { url: string }[] } }
        >;
      };
    };
    const target = (router: string) =>
      http.services[http.routers[router].service].loadBalancer.servers[0].url;
    assert.equal(
      http.routers["deplo-setup"].rule,
      "Host(`deplo-cb00710b.deplo.site`)",
    );
    assert.equal(target("deplo-setup"), "http://deplo:3000");
    assert.deepEqual(http.routers["deplo-setup-link"], {
      rule: "Host(`deplo-cb00710b.deplo.site`) && Path(`/api/agent/link`)",
      entryPoints: [entry],
      service: "deplo-setup-link",
    });
    assert.equal(target("deplo-setup-link"), "http://deplo:3001");
  }
});

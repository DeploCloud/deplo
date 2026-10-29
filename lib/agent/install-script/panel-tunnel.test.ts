import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as yaml from "js-yaml";

import {
  panelTunnelToken,
  withPanelTunnel,
} from "../../deploy/panel-tunnel-stack";
import { panelRoute, withPanelRoute } from "../../deploy/traefik-stack";
import {
  LIVE_STACK,
  bash,
  shellFn,
  updatedHost,
} from "./install-script-test-helpers";

// The stack as the panel leaves it with a tunnel on: route without a resolver, connector beside it.
const TUNNELED = withPanelTunnel(
  withPanelRoute(
    LIVE_STACK.replace(
      "services:\n",
      "services:\n  deplo-socket-proxy:\n    image: tecnativa/docker-socket-proxy:v0.5.0\n",
    ),
    {
      ...panelRoute(LIVE_STACK)!,
      certResolver: null,
    },
  ),
  "eyJhIjoiYWNjdCJ9",
);

async function keptTunnel(dir: string, domain = ""): Promise<string> {
  const script = await readFile(join(process.cwd(), "install.sh"), "utf8");
  const keep = script.match(/^TRAEFIK_TUNNEL_SERVICE=""\n[\s\S]*?^fi$/m);
  assert.ok(keep, "install.sh no longer decides whether the tunnel stays");
  return bash(`set -euo pipefail
MODE=update; DEPLO_DOMAIN="${domain}"; PANEL_HTTPS=true; FALLBACK_HOST=deplo-cb00710b.deplo.site
ENV_FILE=${dir}/.env; TRAEFIK_COMPOSE=${dir}/docker-compose.yml
is_generated_host() { case "$1" in *.deplo.site) return 0 ;; *) return 1 ;; esac; }
${await shellFn("install.sh", "live_panel_route")}
${await shellFn("install.sh", "live_tunnel_service")}
${await shellFn("install.sh", "adopt_live_panel_route")}
adopt_live_panel_route
${keep[0]}
printf '%s' "$TRAEFIK_TUNNEL_SERVICE"
`);
}

test("an update carries the panel's tunnel connector over, exactly as the panel wrote it", async () => {
  const dir = await updatedHost(TUNNELED);
  try {
    const carried = await keptTunnel(dir);
    assert.match(carried, /^ {2}deplo-tunnel:\n/);
    const parsed = yaml.load(`services:\n${carried}\n`) as {
      services: Record<string, unknown>;
    };
    assert.deepEqual(
      parsed.services["deplo-tunnel"],
      (yaml.load(TUNNELED) as { services: Record<string, unknown> }).services[
        "deplo-tunnel"
      ],
    );

    const out = join(dir, "rendered.yml");
    await writeFile(join(dir, "carried.yml"), carried);
    await bash(`set -euo pipefail
TRAEFIK_COMPOSE=${out}
ACME_EMAIL=ops@acme.com PROXY_BIND= HTTP_PORT=80 HTTPS_PORT=443
TRAEFIK_FILE_PROVIDER= TRAEFIK_CERT_MOUNT= TRAEFIK_CONFIG_MOUNT= TRAEFIK_PANEL_CONFIG=
TRAEFIK_TUNNEL_SERVICE="$(cat ${dir}/carried.yml)"
${await shellFn("install.sh", "write_traefik_compose")}
write_traefik_compose`);
    const rendered = await readFile(out, "utf8");
    assert.equal(panelTunnelToken(rendered), "eyJhIjoiYWNjdCJ9");
    assert.deepEqual(
      Object.keys(
        (yaml.load(rendered) as { services: object }).services,
      ).sort(),
      ["deplo-socket-proxy", "deplo-tunnel", "traefik"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a panel moved to another domain by the installer leaves the tunnel behind", async () => {
  const dir = await updatedHost(TUNNELED);
  try {
    assert.equal(await keptTunnel(dir, "other.acme.com"), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stack with no tunnel carries nothing", async () => {
  const dir = await updatedHost();
  try {
    assert.equal(await keptTunnel(dir), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the tunnel's name orders no certificate, and the backup address still does", async () => {
  const out = await bash(`set -euo pipefail
HTTPS_PORT=443; PANEL_HTTPS=true; TRAEFIK_TUNNEL_SERVICE="  deplo-tunnel:"
${await shellFn("install.sh", "panel_router")}
panel_router deplo-panel panel.acme.com
panel_router deplo-panel-fallback deplo-cb00710b.deplo.site
`);
  const [panel, fallback] = out.split("          deplo-panel-fallback:\n");
  assert.match(panel, /tls: \{\}/);
  assert.doesNotMatch(panel, /certResolver/);
  assert.match(fallback, /certResolver: letsencrypt/);
});

test("without a tunnel the panel's name still orders its certificate", async () => {
  const out = await bash(`set -euo pipefail
HTTPS_PORT=443; PANEL_HTTPS=true; TRAEFIK_TUNNEL_SERVICE=""
${await shellFn("install.sh", "panel_router")}
panel_router deplo-panel panel.acme.com
`);
  assert.match(out, /certResolver: letsencrypt/);
});

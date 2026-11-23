import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import * as yaml from "js-yaml";

import { panelRoute, withPanelRoute } from "../../deploy/traefik-stack";
import {
  LIVE_STACK,
  adopt,
  bash,
  shellFn,
  updatedHost,
} from "./install-script-test-helpers";

test("the dashboard's address never carries the interim port", async () => {
  const out = await bash(`set -euo pipefail
PANEL_HOST=deplo-cb00710b.deplo.site
${await shellFn("install.sh", "panel_url")}
HTTPS_PORT=8443; panel_url; echo
HTTPS_PORT=443; panel_url; echo
`);
  assert.equal(
    out,
    "https://deplo-cb00710b.deplo.site\nhttps://deplo-cb00710b.deplo.site\n",
    "the interim proxy port is loopback-only and no address anyone opens",
  );
});

test("the panel's router orders no certificate while the proxy waits on an interim port", async () => {
  const out = await bash(`set -euo pipefail
${await shellFn("install.sh", "panel_router")}
HTTPS_PORT=8443; panel_router deplo-panel deplo-cb00710b.deplo.site
HTTPS_PORT=443; panel_router deplo-panel deplo-cb00710b.deplo.site
`);
  const [waiting, live] = out.split("          deplo-panel:\n").slice(1);
  assert.match(waiting, /tls: \{\}/);
  assert.doesNotMatch(waiting, /certResolver/);
  assert.match(live, /certResolver: letsencrypt/);
});

async function installedPanelConfig(vars: string): Promise<string> {
  const rendered = await bash(`set -euo pipefail
PANEL_HOST=deplo.example.com; FALLBACK_HOST=deplo-cb007109.deplo.site
HTTPS_PORT=443; PANEL_HTTPS=true; TRAEFIK_CUSTOM_CERTS=""; TRAEFIK_DEFAULT_CERT_CONFIG=""
${vars}
${await shellFn("install.sh", "panel_router")}
${await shellFn("install.sh", "offline_router")}
${await shellFn("install.sh", "render_traefik_panel_config")}
render_traefik_panel_config
printf '%s\\n' "$TRAEFIK_PANEL_CONFIG"
`);
  return `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    command:
      - --providers.file.directory=/deplo-dynamic
      - --providers.file.watch=true
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
    configs:
      - source: deplo-panel
        target: /deplo-dynamic/deplo-panel.yml
        mode: 256
${rendered}networks:
  deplo:
    external: true
`;
}

const panelContent = (stack: string) =>
  (yaml.load(stack) as { configs: Record<string, { content: string }> })
    .configs["deplo-panel"].content;

type PanelFile = {
  http: {
    routers: Record<string, { rule: string; [k: string]: unknown }>;
    services: Record<string, unknown>;
  };
};

test("install.sh routes the agent link on both panel names, exactly as the panel rewrites it", async () => {
  for (const vars of [
    "",
    "HTTPS_PORT=8443",
    "PANEL_HTTPS=false",
    "PANEL_HOST=deplo-cb007109.deplo.site",
    "FALLBACK_OFF=true",
  ]) {
    const stack = await installedPanelConfig(vars);
    const file = yaml.load(panelContent(stack)) as PanelFile;
    const route = panelRoute(stack);
    assert.ok(route, vars);
    const hosts = [route.domain, route.fallbackDomain].filter(Boolean);
    assert.deepEqual(
      Object.values(file.http.routers)
        .filter((r) => r.service === "deplo-link")
        .map((r) => r.rule),
      hosts.map((h) => `Host(\`${h}\`) && Path(\`/api/agent/link\`)`),
      vars,
    );
    assert.deepEqual(
      file.http.services["deplo-link"],
      { loadBalancer: { servers: [{ url: "http://deplo:3001" }] } },
      vars,
    );
    assert.equal(
      panelContent(withPanelRoute(stack, route)),
      panelContent(stack),
      `${vars || "a plain install"}: KEEP IN SYNC with withPanelRoute`,
    );
  }
});

test("an update keeps the address the panel moved itself to", async () => {
  const dir = await updatedHost();
  const out = await adopt(dir);
  await rm(dir, { recursive: true, force: true });
  assert.equal(out, "panel.acme.com true\n");
});

test("an update leaves a panel on plain http on plain http", async () => {
  const dir = await updatedHost(
    LIVE_STACK.replace("- websecure", "- web").replace(
      "            tls:\n              certResolver: letsencrypt\n",
      "",
    ),
  );
  const out = await adopt(dir);
  await rm(dir, { recursive: true, force: true });
  assert.equal(out, "panel.acme.com false\n");

  const rendered = await bash(`set -euo pipefail
HTTPS_PORT=443; PANEL_HTTPS=false
${await shellFn("install.sh", "panel_router")}
panel_router deplo-panel panel.acme.com
`);
  assert.match(rendered, /- web\n/);
  assert.doesNotMatch(rendered, /tls/);
});

// The backup address the proxy routes, through an update on a machine at 10.0.0.3 that the internet sees as
// 203.0.113.7 (#234). Prints the backup address the update renders, and whether it stays off.
async function updatedFallback(stack: string, vars = ""): Promise<string> {
  const dir = await updatedHost(stack);
  try {
    return await bash(`set -euo pipefail
MODE=update; FAMILY_FLAG=""; ENV_FILE=${dir}/.env; TRAEFIK_COMPOSE=${dir}/docker-compose.yml
V4_LOCAL=10.0.0.3; PUBLIC_IP=203.0.113.7; HOST_V6=""
FALLBACK_HOST=deplo-cb007107.deplo.site; FALLBACK_OFF=false
${vars}
${await shellFn("install.sh", "ip_hex")}
${await shellFn("install.sh", "ip_label")}
${await shellFn("install.sh", "is_generated_host")}
${await shellFn("install.sh", "live_panel_route")}
${await shellFn("install.sh", "live_panel_fallback")}
${await shellFn("install.sh", "names_this_machine")}
${await shellFn("install.sh", "adopt_live_fallback")}
adopt_live_fallback
echo "$FALLBACK_HOST $FALLBACK_OFF"
`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const withFallback = (host: string) =>
  LIVE_STACK.replace("deplo-cb00710b.deplo.site", host);
const withoutFallback = (stack = LIVE_STACK) =>
  stack.replace(/ {10}deplo-panel-fallback:\n(?: {12,}.*\n)+/, "");

test("an update keeps the backup address the proxy routes, on this machine's own address or the public one", async () => {
  assert.equal(
    await updatedFallback(withFallback("deplo-0a000003.deplo.site")),
    "deplo-0a000003.deplo.site false\n",
    "the machine's own address is not traded for the public one",
  );
  assert.equal(
    await updatedFallback(withFallback("deplo-cb007107.deplo.site")),
    "deplo-cb007107.deplo.site false\n",
  );
});

test("an update leaves a backup address that was turned off, off", async () => {
  assert.equal(
    await updatedFallback(withoutFallback()),
    "deplo-cb007107.deplo.site true\n",
  );
  const stack = await installedPanelConfig("FALLBACK_OFF=true");
  const file = yaml.load(panelContent(stack)) as PanelFile;
  assert.deepEqual(
    Object.keys(file.http.routers).filter((r) => r.startsWith("deplo-panel")),
    ["deplo-panel", "deplo-panel-link"],
  );
  assert.equal(panelRoute(stack)?.fallbackDomain ?? null, null);
});

test("a panel served on its generated host keeps that host through an update", async () => {
  assert.equal(
    await updatedFallback(
      withoutFallback(
        LIVE_STACK.replace("panel.acme.com", "deplo-0a000003.deplo.site"),
      ),
    ),
    "deplo-0a000003.deplo.site false\n",
  );
});

test("the backup address is named again only when it no longer names this machine, or the kind of address moves", async () => {
  assert.equal(
    await updatedFallback(LIVE_STACK),
    "deplo-cb007107.deplo.site false\n",
    "203.0.113.11 is no address of this machine any more",
  );
  assert.equal(
    await updatedFallback(
      withFallback("deplo-0a000003.deplo.site"),
      `FAMILY_FLAG=ipv6; printf 'DEPLO_IP_FAMILY=ipv4\n' >> "$ENV_FILE"`,
    ),
    "deplo-cb007107.deplo.site false\n",
    "--ipv6 on an IPv4 install moves it",
  );
  assert.equal(
    await updatedFallback(
      withFallback("deplo-0a000003.deplo.site"),
      "MODE=install",
    ),
    "deplo-cb007107.deplo.site false\n",
    "a first install names it",
  );
});

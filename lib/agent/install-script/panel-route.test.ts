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

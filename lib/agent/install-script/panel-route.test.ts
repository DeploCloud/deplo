import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import {
  LIVE_STACK,
  adopt,
  bash,
  shellFn,
  updatedHost,
} from "./install-script-test-helpers";

test("the dashboard's address never carries the interim port", async () => {
  const out = await bash(`set -euo pipefail
PANEL_HOST=deplo-cb00710b.nip.io
${await shellFn("install.sh", "panel_url")}
HTTPS_PORT=8443; panel_url; echo
HTTPS_PORT=443; panel_url; echo
`);
  assert.equal(
    out,
    "https://deplo-cb00710b.nip.io\nhttps://deplo-cb00710b.nip.io\n",
    "the interim proxy port is loopback-only and no address anyone opens",
  );
});

test("the panel's router orders no certificate while the proxy waits on an interim port", async () => {
  const out = await bash(`set -euo pipefail
${await shellFn("install.sh", "panel_router")}
HTTPS_PORT=8443; panel_router deplo-panel deplo-cb00710b.nip.io
HTTPS_PORT=443; panel_router deplo-panel deplo-cb00710b.nip.io
`);
  const [waiting, live] = out.split("          deplo-panel:\n").slice(1);
  assert.match(waiting, /tls: \{\}/);
  assert.doesNotMatch(waiting, /certResolver/);
  assert.match(live, /certResolver: letsencrypt/);
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

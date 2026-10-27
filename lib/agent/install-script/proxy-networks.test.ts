import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { bash, shellFn } from "./install-script-test-helpers";

test("a recreated proxy is put back on every Environment's network, and only those", async () => {
  const out = await bash(`exec 9>/dev/null
calls="$(mktemp)"
docker() {
  if [ "$1 $2" = "network ls" ]; then
    printf '%s\\n' bridge deplo deplo-env-environ_1 deplo-team-team_1 \\
      deplo-preview-web-pr-2 myapp_default traefik_deplo-socket
  else echo "$*" >> "$calls"; fi
}
${await shellFn("install.sh", "reconnect_proxy_networks")}
reconnect_proxy_networks
cat "$calls"; rm -f "$calls"`);
  assert.deepEqual(out.trim().split("\n"), [
    "network connect deplo-env-environ_1 deplo-traefik",
    "network connect deplo-team-team_1 deplo-traefik",
    "network connect deplo-preview-web-pr-2 deplo-traefik",
  ]);
});

test("every start of the panel host's proxy is followed by the reconnect", async () => {
  const lines = (
    await readFile(join(process.cwd(), "install.sh"), "utf8")
  ).split("\n");
  const ups = lines
    .map((l, i) => [l, i] as const)
    .filter(([l]) => /docker compose -f "\$TRAEFIK_COMPOSE".* up -d/.test(l));
  assert.ok(ups.length >= 2, "install.sh no longer starts its proxy?");
  for (const [, i] of ups)
    assert.equal(lines[i + 1].trim(), "reconnect_proxy_networks", lines[i]);
});

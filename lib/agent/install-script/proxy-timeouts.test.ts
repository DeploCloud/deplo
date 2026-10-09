import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

import { bash, shellFn } from "./install-script-test-helpers";

const NO_BODY_CEILING = [
  "--entrypoints.web.transport.respondingtimeouts.readtimeout=0",
  "--entrypoints.websecure.transport.respondingtimeouts.readtimeout=0",
];

const traefikCommand = (compose: string) =>
  (yaml.load(compose) as { services: { traefik: { command: string[] } } })
    .services.traefik.command;

test("the panel host's proxy never cuts off a slow upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-proxy-"));
  try {
    const fn = await shellFn("install.sh", "write_traefik_compose");
    await bash(`set -euo pipefail
TRAEFIK_COMPOSE=${dir}/docker-compose.yml
ACME_EMAIL=ops@acme.com PROXY_BIND= HTTP_PORT=80 HTTPS_PORT=443
TRAEFIK_FILE_PROVIDER= TRAEFIK_CERT_MOUNT= TRAEFIK_CONFIG_MOUNT= TRAEFIK_PANEL_CONFIG=
${fn}
write_traefik_compose`);
    const command = traefikCommand(
      await readFile(`${dir}/docker-compose.yml`, "utf8"),
    );
    for (const flag of NO_BODY_CEILING) assert.ok(command.includes(flag), flag);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a remote server's proxy never cuts off a slow upload either", async () => {
  const script = await readFile(
    join(process.cwd(), "install-agent.sh"),
    "utf8",
  );
  const body = script.match(
    /cat > "\$TRAEFIK_DIR\/docker-compose\.yml" <<YAML\n([\s\S]*?)^YAML$/m,
  )?.[1];
  assert.ok(body, "install-agent.sh no longer writes its own proxy stack");
  const compose = await bash(
    `TRAEFIK_DIR=/var/lib/deplo-agent/traefik\ncat <<YAML\n${body}YAML`,
  );
  const command = traefikCommand(compose);
  for (const flag of NO_BODY_CEILING) assert.ok(command.includes(flag), flag);
});

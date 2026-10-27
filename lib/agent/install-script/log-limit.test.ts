import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

import { defaultLogging } from "../../deploy/resources";
import { bash, shellFn } from "./install-script-test-helpers";

type Doc = { services: Record<string, { logging?: unknown }> };

function assertEveryServiceCapped(compose: string, expected: string[]) {
  const services = (yaml.load(compose) as Doc).services;
  assert.deepEqual(Object.keys(services).sort(), [...expected].sort());
  for (const [name, svc] of Object.entries(services))
    assert.deepEqual(svc.logging, defaultLogging(), name);
}

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "deplo-logcap-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The real function, pointed at a scratch daemon.json, with Docker itself stubbed out.
async function writeDaemonJson(
  dir: string,
  existing: object | null,
  opts: { noPython?: boolean } = {},
): Promise<Record<string, unknown>> {
  const cfg = join(dir, "daemon.json");
  if (existing) await writeFile(cfg, JSON.stringify(existing));
  let fn = (
    await shellFn("install.sh", "configure_docker_address_pools")
  ).replaceAll("/etc/docker", dir);
  if (opts.noPython) fn = fn.replace("command -v python3", "false");
  await bash(`exec 9>/dev/null
ip() { :; }; dockerd() { :; }; docker() { :; }; systemctl() { :; }
ok() { :; }; err() { echo "$*" >&2; }; step() { :; }
${await shellFn("install.sh", "pool_candidate_is_free")}
${fn}
configure_docker_address_pools`);
  return JSON.parse(await readFile(cfg, "utf8"));
}

const LOG = { "log-driver": "local", "log-opts": defaultLogging().options };

describe("the installers cap every log they start", () => {
  test("the panel host's proxy stack", () =>
    withDir(async (dir) => {
      await bash(`TRAEFIK_COMPOSE=${dir}/docker-compose.yml
ACME_EMAIL=ops@acme.com PROXY_BIND= HTTP_PORT=80 HTTPS_PORT=443
TRAEFIK_FILE_PROVIDER= TRAEFIK_CERT_MOUNT= TRAEFIK_CONFIG_MOUNT= TRAEFIK_PANEL_CONFIG=
${await shellFn("install.sh", "write_traefik_compose")}
write_traefik_compose`);
      assertEveryServiceCapped(
        await readFile(`${dir}/docker-compose.yml`, "utf8"),
        ["traefik", "deplo-socket-proxy"],
      );
    }));

  test("the panel and its database", () =>
    withDir(async (dir) => {
      await bash(`DEPLO_DIR=${dir} DEPLO_IMAGE=ghcr.io/deplocloud/deplo:0.6.0 DEPLO_EXPOSE=
${await shellFn("install.sh", "write_panel_compose")}
write_panel_compose`);
      assertEveryServiceCapped(
        await readFile(`${dir}/docker-compose.yml`, "utf8"),
        ["postgres", "deplo"],
      );
    }));

  test("a remote server's proxy stack", async () => {
    const script = await readFile(
      join(process.cwd(), "install-agent.sh"),
      "utf8",
    );
    const body = script.match(
      /cat > "\$TRAEFIK_DIR\/docker-compose\.yml" <<YAML\n([\s\S]*?)^YAML$/m,
    )?.[1];
    assert.ok(body, "install-agent.sh no longer writes its own proxy stack");
    assertEveryServiceCapped(
      await bash(
        `TRAEFIK_DIR=/var/lib/deplo-agent/traefik\ncat <<YAML\n${body}YAML`,
      ),
      ["traefik", "deplo-socket-proxy"],
    );
  });

  test("a fresh host's daemon.json gets the same default", () =>
    withDir(async (dir) => {
      const d = await writeDaemonJson(dir, null);
      assert.ok(d["default-address-pools"]);
      assert.equal(d["log-driver"], LOG["log-driver"]);
      assert.deepEqual(d["log-opts"], LOG["log-opts"]);
    }));

  for (const noPython of [false, true])
    describe(noPython ? "merged with jq" : "merged with python3", () => {
      test("an existing daemon.json keeps its keys and gains the default", () =>
        withDir(async (dir) => {
          const d = await writeDaemonJson(dir, { debug: true }, { noPython });
          assert.equal(d.debug, true);
          assert.ok(d["default-address-pools"]);
          assert.equal(d["log-driver"], LOG["log-driver"]);
          assert.deepEqual(d["log-opts"], LOG["log-opts"]);
        }));

      test("the operator's own log driver wins", () =>
        withDir(async (dir) => {
          const d = await writeDaemonJson(
            dir,
            { "log-driver": "journald" },
            { noPython },
          );
          assert.equal(d["log-driver"], "journald");
          assert.equal(d["log-opts"], undefined);
        }));

      test("the operator's own log options win", () =>
        withDir(async (dir) => {
          const own = { "log-opts": { "max-size": "1g" } };
          const d = await writeDaemonJson(dir, own, { noPython });
          assert.equal(d["log-driver"], undefined);
          assert.deepEqual(d["log-opts"], own["log-opts"]);
        }));
    });
});

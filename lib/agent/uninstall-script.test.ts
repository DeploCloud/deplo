import { test } from "node:test";
import assert from "node:assert/strict";

import { renderUninstallScript } from "./uninstall-script";
import { uninstallCommand } from "./bootstrap";

test("the uninstall command is a copy-and-run one-liner that only asks for --yes", () => {
  assert.equal(
    uninstallCommand({ baseUrl: "https://deplo.example" }),
    "curl -fsSL 'https://deplo.example/uninstall.sh' --output /tmp/deplo-uninstall.sh && sudo bash /tmp/deplo-uninstall.sh --yes --agent-only",
  );
  assert.doesNotMatch(uninstallCommand({ baseUrl: "https://x" }), /purge-data/);
  assert.match(uninstallCommand({ baseUrl: "https://x" }), /--agent-only/);
});

test("removes the agent service, binary, state, proxy and network", async () => {
  const script = await renderUninstallScript();

  assert.match(script, /systemctl disable --now deplo-agent/);
  assert.match(script, /rm -f "\$UNIT"/);
  assert.match(script, /AGENT_BIN="\/usr\/local\/bin\/deplo-agent"/);
  assert.match(script, /rm -rf "\$AGENT_DATA"/);
  assert.match(script, /docker network rm "\$n"/);
  assert.match(script, /--filter label=deplo\.managed=true/);
  assert.match(script, /deplo-traefik/);
  assert.match(script, /deplo-ssh-gateway/);
});

test("removes the control plane, by compose, before Traefik goes away under it", async () => {
  const script = await renderUninstallScript();

  assert.match(script, /DEPLO_DIR="\/opt\/deplo"/);
  assert.match(script, /docker compose -f "\$CP_COMPOSE"/);
  assert.match(script, /docker compose -f "\$CP_TRAEFIK_COMPOSE"/);
  assert.match(script, /DOWN_ARGS=\(down --remove-orphans\)/);
  assert.match(
    script,
    /"\$PURGE" = true \] && DOWN_ARGS=\(down -v --remove-orphans\)/,
  );
  assert.match(
    script,
    /CP_CONTAINERS=\(deplo-deplo-1 deplo-postgres-1 traefik-deplo-socket-proxy-1\)/,
  );

  const guardAt = script.indexOf('if [ "$AGENT_ONLY" = true ]; then');
  const downAt = script.indexOf('docker compose -f "$CP_COMPOSE"');
  assert.ok(guardAt > 0, "the --agent-only guard must exist");
  assert.ok(
    downAt > guardAt,
    "the control-plane teardown must sit inside the --agent-only guard",
  );
});

test("the served script defaults to removing everything, /uninstall-agent.sh does not", async () => {
  const full = await renderUninstallScript();
  const agentOnly = await renderUninstallScript({ agentOnly: true });

  assert.match(full, /\nAGENT_ONLY=false\n/);
  assert.doesNotMatch(full, /\nAGENT_ONLY=true\n/);
  assert.match(agentOnly, /\nAGENT_ONLY=true\n/);
  assert.doesNotMatch(agentOnly, /\nAGENT_ONLY=false\n/);
  assert.equal(
    agentOnly.replace("\nAGENT_ONLY=true\n", "\nAGENT_ONLY=false\n"),
    full,
  );
});

test("is a dry run unless --yes, and never deletes data without --purge-data", async () => {
  const script = await renderUninstallScript();

  assert.match(script, /APPLY=false/);
  assert.match(script, /--yes\|-y\)\s+APPLY=true/);
  assert.match(script, /DRY RUN/);

  const purgeAt = script.indexOf('if [ "$PURGE" = true ]');
  assert.ok(purgeAt > 0, "the --purge-data branch must exist");
  const beforePurge = script.slice(0, purgeAt);
  assert.doesNotMatch(beforePurge, /docker volume rm/);
  assert.doesNotMatch(beforePurge, /docker rmi/);
  assert.doesNotMatch(beforePurge, /rm -rf \/data/);
  assert.doesNotMatch(beforePurge, /rm -rf "\$DEPLO_DIR"/);

  const backupsAt = script.indexOf('if [ "$PURGE_BACKUPS" = true ]');
  assert.ok(backupsAt > 0, "the --purge-backups branch must exist");
  assert.doesNotMatch(script.slice(0, backupsAt), /rm -rf \/data\/backups/);
});

test("--agent-only leaves the control plane's own volumes and directory alone", async () => {
  const script = await renderUninstallScript();

  assert.match(script, /grep -E '\^deplo-'/);
  assert.match(script, /grep -E '\^deplo'/);
  assert.match(
    script,
    /\[ "\$AGENT_ONLY" != true \] && \[ -d "\$DEPLO_DIR" \]/,
  );
});

test("never uninstalls Docker or rewrites its configuration", async () => {
  const script = await renderUninstallScript();

  assert.doesNotMatch(script, /get\.docker\.com/);
  assert.doesNotMatch(script, /apt-get (remove|purge).*docker/);
  assert.doesNotMatch(script, /systemctl disable --now docker\b/);
  assert.match(script, /Docker Engine/);

  assert.doesNotMatch(script, /systemctl restart docker/);
  assert.doesNotMatch(script, /(mv|cp|rm)[^\n]*daemon\.json/);
  assert.match(script, /daemon\.json\.deplo-bak/);
});

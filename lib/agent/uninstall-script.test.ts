import { test } from "node:test";
import assert from "node:assert/strict";

import { renderUninstallScript } from "./uninstall-script";
import { uninstallCommand } from "./bootstrap";

/**
 * The uninstaller is the ONLY thing that can remove Deplo's footprint from a host
 * (removal in the dashboard revokes trust and forgets the row — it cannot, and no
 * longer claims to, touch the box). So the script's safety properties are load-
 * bearing: it must be a dry run by default, it must never delete data without an
 * explicit second flag, and it must never uninstall Docker.
 */

test("the uninstall command is a copy-and-run one-liner that only asks for --yes", () => {
  assert.equal(
    uninstallCommand({ baseUrl: "https://deplo.example" }),
    "curl -fsSL 'https://deplo.example/uninstall-agent.sh' | sudo bash -s -- --yes",
  );
  // --purge-data destroys volumes and images: the operator must reach for it, it
  // is never in the command we hand them.
  assert.doesNotMatch(uninstallCommand({ baseUrl: "https://x" }), /purge-data/);
});

test("removes the agent service, binary, state, proxy and network", async () => {
  const script = await renderUninstallScript();

  assert.match(script, /systemctl disable --now deplo-agent/);
  assert.match(script, /rm -f "\$UNIT"/);
  assert.match(script, /AGENT_BIN="\/usr\/local\/bin\/deplo-agent"/);
  assert.match(script, /rm -rf "\$AGENT_DATA"/);
  assert.match(script, /docker network rm deplo\b/);
  // Apps, databases and dev containers all carry this label — one sweep gets them
  // all, and it cannot touch a container Deplo did not create.
  assert.match(script, /--filter label=deplo\.managed=true/);
  assert.match(script, /deplo-traefik/);
  assert.match(script, /deplo-ssh-gateway/);
});

test("is a dry run unless --yes, and never deletes data without --purge-data", async () => {
  const script = await renderUninstallScript();

  assert.match(script, /APPLY=false/);
  assert.match(script, /--yes\|-y\)\s+APPLY=true/);
  assert.match(script, /DRY RUN/);

  // Every data-destroying verb must sit inside the --purge-data branch. Take the
  // text before that branch opens and assert none of them appear in it.
  const purgeAt = script.indexOf('if [ "$PURGE" = true ]');
  assert.ok(purgeAt > 0, "the --purge-data branch must exist");
  const beforePurge = script.slice(0, purgeAt);
  assert.doesNotMatch(beforePurge, /docker volume rm/);
  assert.doesNotMatch(beforePurge, /docker rmi/);
  assert.doesNotMatch(beforePurge, /rm -rf \/data/);
});

test("never uninstalls Docker — other things on the host may need it", async () => {
  const script = await renderUninstallScript();

  assert.doesNotMatch(script, /get\.docker\.com/);
  assert.doesNotMatch(script, /apt-get (remove|purge).*docker/);
  assert.doesNotMatch(script, /systemctl disable --now docker\b/);
  assert.match(script, /Docker Engine/); // …and it says so, in the summary.
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { installOneLiner, INSTALL_URL } from "./install-script";

/**
 * The panel offers this command as the way to apply an update, so the two halves
 * of that promise are checked together: it is the installer, and the installer
 * updates an existing instance without being told to.
 */

test("the update one-liner runs the installer, no flags", () => {
  assert.equal(installOneLiner(), `curl -fsSL ${INSTALL_URL} | bash`);
  assert.ok(INSTALL_URL.endsWith("/install.sh"));
  assert.ok(INSTALL_URL.startsWith("https://"));
});

test("install.sh updates in place when Deplo is already there", async () => {
  const script = await readFile(join(process.cwd(), "install.sh"), "utf8");
  assert.match(
    script,
    /MODE="update"/,
    "install.sh no longer has an update mode - the panel's one-liner would reinstall",
  );
  // No flag: the command above passes none, and a second install would rotate
  // nothing but would also never pull a newer image.
  assert.match(script, /\[ -f "\$ENV_FILE" \] && MODE="update"/);
  // `latest` is what an update resolves to when GitHub cannot be asked, and the
  // release workflow pushes that tag - without it a rate-limited host is stuck.
  assert.match(script, /DEPLO_VERSION="\$\{DEPLO_VERSION:-latest\}"/);
});

test("the installer's only question is the takeover", async () => {
  const script = await readFile(join(process.cwd(), "install.sh"), "utf8");
  const prompts = script.match(/ask "[^"]+"/g) ?? [];
  assert.deepEqual(
    prompts.map((p) => p.slice(5, -1)),
    ["Migrate off $FOREIGN_LABEL and let Deplo replace it? [y/N]"],
    "the one-liner must ask nothing but the takeover - a domain goes on --domain",
  );
});

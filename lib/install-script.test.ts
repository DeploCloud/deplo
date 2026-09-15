import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { installOneLiner, INSTALL_URL } from "./install-script";

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
  assert.match(script, /\[ -f "\$ENV_FILE" \] && MODE="update"/);
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

test("--public-setup writes an empty key and prints a bare link", async () => {
  const script = await readFile(join(process.cwd(), "install.sh"), "utf8");
  assert.match(script, /--public-setup\) PUBLIC_SETUP=true/);
  assert.match(script, /echo "DEPLO_SETUP_KEY="/);
  assert.match(script, /--public-setup {3}no setup key/);
  assert.match(script, /\[ -n "\$SETUP_KEY" \] \|\| \{ printf '%s\/setup'/);
});

test("install.sh runs with no domain given", async () => {
  const script = await readFile(join(process.cwd(), "install.sh"), "utf8");
  assert.match(script, /^DEPLO_DOMAIN="\$\{DEPLO_DOMAIN:-\}"$/m);
});

test("the setup link is never printed inside the summary card", async () => {
  const script = await readFile(join(process.cwd(), "install.sh"), "utf8");
  assert.ok(
    !script.includes('card_kv "Set up"'),
    "the card would cut the key off the link",
  );
  assert.ok(
    script.includes("Open %b%s%b and create your account"),
    "nothing prints it whole",
  );
});

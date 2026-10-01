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

test("no flag leaves the setup open to whoever arrives first", async () => {
  const script = await readFile(join(process.cwd(), "install.sh"), "utf8");
  assert.doesNotMatch(script, /public-setup|PUBLIC_SETUP/);
  assert.doesNotMatch(script, /echo "DEPLO_SETUP_KEY="$/m);
  // An empty key left by an older install is replaced, not kept.
  assert.match(script, /grep -q '\^DEPLO_SETUP_KEY=\.'/);
});

test("--owner-email and --owner-password create the owner, the password kept off every record", async () => {
  const script = await readFile(join(process.cwd(), "install.sh"), "utf8");
  assert.match(script, /--owner-email\) +OWNER_EMAIL="\$\{2:-\}"; shift ;;/);
  assert.match(
    script,
    /--owner-password\) OWNER_PASSWORD="\$\{2:-\}"; shift ;;/,
  );
  assert.match(script, /--owner-email and --owner-password go together/);
  // The transcript logs the arguments; the value after --owner-password is hidden.
  assert.match(
    script,
    /\[ "\$prev" = --owner-password \]; then LOG_ARGS\+=\("<hidden>"\)/,
  );
  assert.match(script, /^ui_init \$\{LOG_ARGS\[@\]/m);
  // On stdin to the bundled tool, with the trace off around it.
  assert.match(
    script,
    /trace_off\n\s+OWNER_OUT="\$\(printf '%s' "\$OWNER_PASSWORD" \|\n\s+\/usr\/local\/bin\/deplo recover bootstrap-owner "\$OWNER_EMAIL"/,
  );
  for (const line of script.split("\n"))
    if (line.includes("$OWNER_PASSWORD") && !line.includes("printf '%s'"))
      assert.match(
        line,
        /-n "\$OWNER_PASSWORD"|-z "\$OWNER_PASSWORD"|#OWNER_PASSWORD/,
      );
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
    script.includes(`Open %b%s%b and %s.\\n' "$C_ACC" "$(first_url)"`),
    "nothing prints it whole",
  );
});

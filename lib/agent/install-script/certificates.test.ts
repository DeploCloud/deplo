import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bash, shellFn, updatedHost } from "./install-script-test-helpers";

test("an update carries over the certificates the panel installed", async () => {
  // They live in a config this script does not render, in the file it rewrites.
  const dir = await updatedHost();
  const out = await bash(`set -euo pipefail
TRAEFIK_COMPOSE=${dir}/docker-compose.yml
DEFAULT_CERT_PEM=${dir}/missing.pem
${(await readFile(join(process.cwd(), "install.sh"), "utf8")).match(/^TRAEFIK_CUSTOM_CERTS="\$\([\s\S]*?^\)"$/m)![0]}
${(await readFile(join(process.cwd(), "install.sh"), "utf8")).match(/^TRAEFIK_CONFIG_MOUNT="\$\([\s\S]*?^\)"$/m)![0]}
printf '%s\n---\n%s\n' "$TRAEFIK_CUSTOM_CERTS" "$TRAEFIK_CONFIG_MOUNT"
`);
  await rm(dir, { recursive: true, force: true });
  const [carried, mount] = out.split("\n---\n");
  assert.match(carried, /^ {2}deplo-certificates:$/m);
  assert.match(carried, /certFile: \/deplo-certs\/custom-0\.pem/);
  assert.doesNotMatch(carried, /networks:/);
  assert.match(mount, /- source: deplo-certificates/);
});

test("the fallback certificate names the IP only, never a host Traefik would order for", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-cert-"));
  const san = (pem: string) =>
    bash(
      `openssl x509 -in ${pem} -noout -ext subjectAltName | tail -n +2 | tr -d ' \\n'`,
    );
  const fn = await shellFn("install.sh", "ensure_default_cert");
  const env = `CERT_DIR=${dir}; DEFAULT_CERT_PEM=${dir}/default.pem; DEFAULT_CERT_KEY=${dir}/default-key.pem
FALLBACK_HOST=deplo-cb00710b.nip.io; TARGET_IP=203.0.113.7; exec 9>/dev/null`;
  await bash(`set -euo pipefail\n${env}\n${fn}\nensure_default_cert`);
  assert.equal(await san(`${dir}/default.pem`), "IPAddress:203.0.113.7");

  // Minted once: a second run keeps the file, which is the whole point of it.
  const before = await readFile(`${dir}/default.pem`, "utf8");
  await bash(`set -euo pipefail\n${env}\n${fn}\nensure_default_cert`);
  assert.equal(await readFile(`${dir}/default.pem`, "utf8"), before);

  // An earlier install minted one carrying the host, which made Traefik skip Let's Encrypt for it, so an update re-mints that one.
  await bash(`openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
    -keyout ${dir}/default-key.pem -out ${dir}/default.pem -subj /CN=deplo-cb00710b.nip.io \
    -addext "subjectAltName=DNS:deplo-cb00710b.nip.io,IP:203.0.113.7" 2>/dev/null`);
  await bash(`set -euo pipefail\n${env}\n${fn}\nensure_default_cert`);
  assert.equal(await san(`${dir}/default.pem`), "IPAddress:203.0.113.7");
  await rm(dir, { recursive: true, force: true });
});

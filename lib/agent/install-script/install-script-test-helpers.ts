import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const FAKE = {
  tag: "v2.3.0",
  amd64Url:
    "https://github.com/DeploCloud/deplo-agent/releases/download/v2.3.0/deplo-agent-linux-amd64",
  amd64Sha: "a".repeat(64),
  arm64Url:
    "https://github.com/DeploCloud/deplo-agent/releases/download/v2.3.0/deplo-agent-linux-arm64",
  arm64Sha: "b".repeat(64),
};

export function stubReleaseFetch() {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/releases/latest")) {
      return new Response(
        JSON.stringify({
          tag_name: FAKE.tag,
          assets: [
            {
              name: "deplo-agent-linux-amd64",
              browser_download_url: FAKE.amd64Url,
            },
            {
              name: "deplo-agent-linux-arm64",
              browser_download_url: FAKE.arm64Url,
            },
            {
              name: "checksums.txt",
              browser_download_url: "https://example/checksums.txt",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("checksums.txt")) {
      return new Response(
        `${FAKE.amd64Sha}  deplo-agent-linux-amd64\n${FAKE.arm64Sha}  deplo-agent-linux-arm64\n`,
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

export function shVar(script: string, name: string): string | null {
  const m = script.match(new RegExp(`^${name}="([^"]*)"`, "m"));
  return m ? m[1] : null;
}

export async function shellFn(file: string, name: string): Promise<string> {
  const script = await readFile(join(process.cwd(), file), "utf8");
  const start = script.search(new RegExp(`^${name}\\(\\)\\s*\\{`, "m"));
  assert.ok(start >= 0, `${name} not found in ${file}`);
  const head = script.slice(start);
  const first = head.slice(0, head.indexOf("\n"));
  return first.trimEnd().endsWith("}")
    ? first
    : head.slice(0, head.indexOf("\n}\n") + 2);
}

export async function bash(body: string, extraPath?: string) {
  const { stdout } = await promisify(execFile)("/bin/bash", ["-c", body], {
    env: {
      ...process.env,
      ...(extraPath ? { PATH: `${extraPath}:/usr/bin:/bin` } : {}),
    },
  });
  return stdout;
}

export const LIVE_STACK = `services:
  traefik:
    command:
      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com
configs:
  deplo-panel:
    content: |
      http:
        routers:
          deplo-panel:
            rule: Host(\`panel.acme.com\`)
            entryPoints:
              - websecure
            service: deplo-panel
            priority: 2
            tls:
              certResolver: letsencrypt
          deplo-panel-fallback:
            rule: Host(\`deplo-cb00710b.nip.io\`)
            entryPoints:
              - websecure
            service: deplo-panel
            priority: 2
        services:
          deplo-panel:
            loadBalancer:
              servers:
                - url: http://deplo:3000
              passHostHeader: true
  deplo-certificates:
    content: |
      tls:
        certificates:
          - certFile: /deplo-certs/custom-0.pem
            keyFile: /deplo-certs/custom-0-key.pem
networks:
  deplo:
    external: true
`;

export async function updatedHost(stack = LIVE_STACK) {
  const dir = await mkdtemp(join(tmpdir(), "deplo-update-"));
  await writeFile(join(dir, "docker-compose.yml"), stack);
  await writeFile(
    join(dir, ".env"),
    "DEPLO_DOMAIN=\nACME_EMAIL=admin@old.example\n",
  );
  return dir;
}

export async function adopt(dir: string) {
  return bash(`set -euo pipefail
MODE=update; DEPLO_DOMAIN=""; PANEL_HTTPS=true; FALLBACK_HOST=deplo-cb00710b.nip.io
ENV_FILE=${dir}/.env; TRAEFIK_COMPOSE=${dir}/docker-compose.yml
${await shellFn("install.sh", "live_panel_route")}
${await shellFn("install.sh", "adopt_live_panel_route")}
adopt_live_panel_route
echo "$DEPLO_DOMAIN $PANEL_HTTPS"
`);
}

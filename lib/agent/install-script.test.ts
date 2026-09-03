import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { renderInstallScript } from "./install-script";
import { __resetReleaseCacheForTests } from "./release";

/**
 * The install script is a TEMPLATE: the control plane fills in the per-arch binary
 * URLs + sha256s via a plain replaceAll of the `__…__` sentinels at serve time,
 * reading them from the latest GitHub release of DeploCloud/deplo-agent.
 */

const FAKE = {
  tag: "v2.3.0",
  amd64Url:
    "https://github.com/DeploCloud/deplo-agent/releases/download/v2.3.0/deplo-agent-linux-amd64",
  amd64Sha: "a".repeat(64),
  arm64Url:
    "https://github.com/DeploCloud/deplo-agent/releases/download/v2.3.0/deplo-agent-linux-arm64",
  arm64Sha: "b".repeat(64),
};

/**
 * Stub global fetch to serve a release whose assets include both arch binaries
 * plus a checksums.txt. resolveLatestAgentRelease makes two calls: the release
 * JSON, then the checksums asset - we branch on the URL.
 */
function stubReleaseFetch() {
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

afterEach(() => {
  __resetReleaseCacheForTests();
});

/** Pull a `KEY="value"` assignment out of the rendered script. */
function shVar(script: string, name: string): string | null {
  const m = script.match(new RegExp(`^${name}="([^"]*)"`, "m"));
  return m ? m[1] : null;
}

test("renderInstallScript substitutes per-arch URLs + sha256 from the release", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.ok(script, "expected a rendered script (release resolvable)");
    assert.equal(shVar(script!, "AGENT_VERSION"), "2.3.0");
    assert.equal(shVar(script!, "AGENT_URL_AMD64"), FAKE.amd64Url);
    assert.equal(shVar(script!, "AGENT_SHA256_AMD64"), FAKE.amd64Sha);
    assert.equal(shVar(script!, "AGENT_URL_ARM64"), FAKE.arm64Url);
    assert.equal(shVar(script!, "AGENT_SHA256_ARM64"), FAKE.arm64Sha);
  } finally {
    restore();
  }
});

test("renderInstallScript returns null when no release can be resolved", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("not found", { status: 404 })) as typeof fetch;
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.equal(
      script,
      null,
      "unresolvable release must 503 (null), not serve unverifiable installer",
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("rendered script does NOT contain an unsubstituted sentinel token", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.ok(script);
    assert.ok(
      !script!.includes("__AGENT_URL_AMD64__"),
      "still contains __AGENT_URL_AMD64__",
    );
    assert.ok(!script!.includes("__AGENT_SHA256_AMD64__"));
    assert.ok(!script!.includes("__AGENT_VERSION__"));
  } finally {
    restore();
  }
});

test("the self-guard PASSES on the rendered script (would-fire bug regression)", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.ok(script);
    const url = shVar(script!, "AGENT_URL_AMD64")!;
    assert.ok(
      !guardMatches(url),
      "rendered AGENT_URL_AMD64 trips the install guard - the script can never run",
    );
  } finally {
    restore();
  }
});

/**
 * An UNQUOTED heredoc is expanded by the shell, so a backtick inside one - even
 * in a comment - is a command substitution. `-` was exactly that, and every agent
 * install opened with "bash: line 517: -: command not found".
 */
test("no unquoted heredoc runs a command it did not mean to", async () => {
  for (const name of ["install-agent.sh", "install.sh", "uninstall.sh"]) {
    const text = await readFile(join(process.cwd(), name), "utf8").catch(
      () => "",
    );
    if (!text) continue;
    let delim: string | null = null;
    let expands = false;
    text.split("\n").forEach((line, i) => {
      if (delim === null) {
        const m =
          /<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"?([A-Za-z_][A-Za-z0-9_]*)"?)\s*$/.exec(
            line,
          );
        if (m) {
          delim = m[1] ?? m[2];
          expands = m[1] === undefined;
        }
        return;
      }
      if (line.trim() === delim) {
        delim = null;
        return;
      }
      if (!expands) return;
      const live = line.replace(/\\[`$]/g, "");
      assert.ok(
        !live.includes("`") && !live.includes("$("),
        `${name}:${i + 1} substitutes a command inside a heredoc: ${line.trim()}`,
      );
    });
  }
});

test("the self-guard FIRES on the raw repo template", async () => {
  const template = await readFile(
    join(process.cwd(), "install-agent.sh"),
    "utf8",
  );
  const url = shVar(template, "AGENT_URL_AMD64")!;
  assert.ok(
    guardMatches(url),
    "raw template AGENT_URL_AMD64 must trip the guard (refuse the repo copy)",
  );
});

/**
 * Mirror the shell guard `case "$AGENT_URL_AMD64" in *__AGENT_URL*AMD64__*)`. The
 * pattern is the sentinel split by a wildcard so the exact token never appears
 * literally where replaceAll could rewrite it.
 */
function guardMatches(url: string): boolean {
  return /__AGENT_URL.*AMD64__/.test(url);
}

/* ------------------------------------------------------------------ */
/* The Docker address-pool step                                        */
/* ------------------------------------------------------------------ */

/**
 * Docker's default pools cap a host at ~31 networks and Deplo takes one PER APP,
 * so both installers widen the pool. The step must run before ANYTHING allocates a
 * subnet. The base must be CHOSEN against the host's routes. - PARITY.
 */

/** The address-pool block, comments and indentation stripped, for comparison. */
/**
 * Where the installer INVOKES the pool step. Matched by regex rather than by the
 * literal "\nconfigure_docker_address_pools\n": install-agent.sh wraps the call in
 * a storage-only guard, so it is indented there and bare in install.sh.
 */
function poolCallIndex(script: string): number {
  return script.search(/^[ \t]*configure_docker_address_pools$/m);
}

function poolBlock(script: string): string {
  const start = script.indexOf("pool_candidate_is_free() {");
  // Up to the END of the second function, not to the call: parity is about the
  // two DEFINITIONS being identical. install-agent.sh wraps its call in a
  // storage-only guard, which is a legitimate difference at the call site.
  const end = script.lastIndexOf("\n}\n", poolCallIndex(script)) + 3;
  assert.ok(
    start >= 0 && end > start,
    "address-pool block not found in installer",
  );
  return script
    .slice(start, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .join("\n");
}

test("the address-pool step runs BEFORE anything creates a docker network", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const agent = await renderInstallScript();
    assert.ok(agent);
    const configured = poolCallIndex(agent!);
    const firstNetwork = agent!.indexOf("docker network create deplo");
    assert.ok(
      configured > 0,
      "install-agent.sh never calls configure_docker_address_pools",
    );
    assert.ok(
      firstNetwork > 0,
      "install-agent.sh no longer creates the Deplo network?",
    );
    assert.ok(
      configured < firstNetwork,
      "pools are configured AFTER the first network is created - the host stays capped at ~31 apps",
    );

    const host = await readFile(join(process.cwd(), "install.sh"), "utf8");
    const hostConfigured = poolCallIndex(host);
    const hostNetwork = host.indexOf("docker network inspect deplo");
    assert.ok(
      hostConfigured > 0,
      "install.sh never calls configure_docker_address_pools",
    );
    assert.ok(
      hostNetwork > 0,
      "install.sh no longer creates the Deplo network?",
    );
    assert.ok(
      hostConfigured < hostNetwork,
      "install.sh configures pools AFTER creating the Deplo network - the step is a no-op",
    );
  } finally {
    restore();
  }
});

test("no installer ever hardcodes 10.0.0.0/8 as the address pool", async () => {
  for (const file of ["install.sh", "install-agent.sh"]) {
    const script = await readFile(join(process.cwd(), file), "utf8");
    // CODE only: the block comment names the range precisely to warn the next
    // editor off it, and a test that can't tell prose from config would fire on
    // the warning itself.
    const code = script
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    assert.ok(
      !code.includes("10.0.0.0/8"),
      `${file} hardcodes 10.0.0.0/8 - it swallows the host's own LAN/VPN and dockerd won't start`,
    );
  }
});

test("both installers carry the SAME address-pool block", async () => {
  const host = await readFile(join(process.cwd(), "install.sh"), "utf8");
  const agent = await readFile(join(process.cwd(), "install-agent.sh"), "utf8");
  assert.equal(
    poolBlock(host),
    poolBlock(agent),
    "install.sh and install-agent.sh have drifted - the address-pool block must stay identical",
  );
});

/* ------------------------------------------------------------------ */
/* The firewall check                                                  */
/* ------------------------------------------------------------------ */

/**
 * The installer never edits a firewall - it detects one that would keep the panel
 * from dialing the agent and prints the command. Run the real shell function
 * against stub `ufw` / `firewall-cmd` binaries.
 */
async function firewallFn(): Promise<string> {
  const script = await readFile(
    join(process.cwd(), "install-agent.sh"),
    "utf8",
  );
  const start = script.indexOf("firewall_fix_command() {");
  const end = script.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "firewall_fix_command not found");
  return script.slice(start, end + 2);
}

async function runFirewallCheck(stubs: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "deplo-fw-"));
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(join(dir, name), body, { mode: 0o755 });
  }
  const { stdout } = await promisify(execFile)(
    "/bin/bash",
    [
      "-c",
      `set -euo pipefail\nAGENT_PORT=9443\n${await firewallFn()}\nfirewall_fix_command`,
    ],
    { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } },
  );
  await rm(dir, { recursive: true, force: true });
  return stdout;
}

const ufwStub = (...lines: string[]) =>
  `#!/bin/sh\n${lines.map((l) => `echo ${JSON.stringify(l)}`).join("\n")}\n`;

test("a firewall holding the agent port prints the fix, per tool", async () => {
  assert.equal(
    await runFirewallCheck({
      ufw: ufwStub("Status: active", "22/tcp  ALLOW  Anywhere"),
    }),
    "ufw allow 9443/tcp",
  );
  assert.equal(
    await runFirewallCheck({
      "firewall-cmd": `#!/bin/sh\ncase "$1" in --state) exit 0 ;; --list-ports) echo "80/tcp 443/tcp" ;; esac\n`,
    }),
    "firewall-cmd --permanent --add-port=9443/tcp && firewall-cmd --reload",
  );
});

test("a firewall that already allows the agent port stays quiet", async () => {
  const cases: Record<string, string>[] = [
    { ufw: ufwStub("Status: active", "9443/tcp  ALLOW  Anywhere") },
    { ufw: ufwStub("Status: inactive") },
    {},
  ];
  for (const stubs of cases) {
    assert.equal(await runFirewallCheck(stubs), "");
  }
});

test("a port that merely CONTAINS the agent port is not a match", async () => {
  assert.equal(
    await runFirewallCheck({
      ufw: ufwStub("Status: active", "19443/tcp  ALLOW  Anywhere"),
    }),
    "ufw allow 9443/tcp",
  );
});

/* ------------------------------------------------------------------ */
/* The takeover's stop / rollback                                      */
/* ------------------------------------------------------------------ */

/** One shell function, lifted out of an installer so it can be driven directly. */
async function shellFn(file: string, name: string): Promise<string> {
  const script = await readFile(join(process.cwd(), file), "utf8");
  const start = script.search(new RegExp(`^${name}\\(\\)\\s*\\{`, "m"));
  assert.ok(start >= 0, `${name} not found in ${file}`);
  const head = script.slice(start);
  const first = head.slice(0, head.indexOf("\n"));
  // A one-liner closes on its own line; anything else runs to the next `\n}`.
  return first.trimEnd().endsWith("}")
    ? first
    : head.slice(0, head.indexOf("\n}\n") + 2);
}

async function bash(body: string, extraPath?: string) {
  const { stdout } = await promisify(execFile)("/bin/bash", ["-c", body], {
    env: {
      ...process.env,
      ...(extraPath ? { PATH: `${extraPath}:/usr/bin:/bin` } : {}),
    },
  });
  return stdout;
}

/* ------------------------------------------------------------------ */
/* The takeover's cutover: one address, the proxy moves, the panel stays */
/* ------------------------------------------------------------------ */

test("the dashboard's address never carries the interim port", async () => {
  const out = await bash(`set -euo pipefail
PANEL_HOST=deplo-cb00710b.nip.io
${await shellFn("install.sh", "panel_url")}
HTTPS_PORT=8443; panel_url; echo
HTTPS_PORT=443; panel_url; echo
`);
  assert.equal(
    out,
    "https://deplo-cb00710b.nip.io\nhttps://deplo-cb00710b.nip.io\n",
    "the interim proxy port is loopback-only and no address anyone opens",
  );
});

test("the cutover moves the proxy and leaves the panel's container alone", async () => {
  const out = await bash(`set -euo pipefail
exec 9>/dev/null
write_traefik_compose() { echo "traefik bind=\${PROXY_BIND}\${HTTP_PORT}/\${HTTPS_PORT}"; }
write_panel_compose() { echo "PANEL REWRITTEN"; }
takeover_up_stacks() { echo up; }
${await shellFn("install.sh", "takeover_apply_ports")}
takeover_apply_ports 80 443
takeover_apply_ports 8080 8443
`);
  assert.equal(
    out,
    "traefik bind=80/443\nup\ntraefik bind=127.0.0.1:8080/8443\nup\n",
    "only the proxy is re-rendered: a panel recreated mid-cutover is the browser losing it",
  );
});

test("the removal is followed by a Docker restart, and only then is the takeover over", async () => {
  // `docker swarm leave` leaves every network alive across it with a dead
  // embedded DNS (measured); the daemon restart after the removal is what fixes
  // it, so `removed` - which is what sends the browser to the dashboard - has to
  // come after it.
  const out = await bash(`set -euo pipefail
exec 9>/dev/null
C_B=; C_OFF=; C_ACC=; PUBLIC_URL=https://x
blank() { :; }; spin_start() { :; }; spin_ok() { :; }; spin_warn() { :; }
foreign_remove() { echo foreign_remove; }
restart_docker() { echo restart_docker; }
takeover_up_stacks() { echo up; }
ensure_proxy_bound() { echo proxy_bound; }
wait_for_proxy() { echo "wait_for_proxy $1"; }
state_set() { echo "state $1=$2"; }
takeover_post() { echo "post $1"; }
takeover_unit_remove() { echo unit_remove; }
${await shellFn("install.sh", "takeover_after_cutover")}
takeover_after_cutover
`);
  // The "Next" block it prints for the transcript is not part of the order.
  const calls = out
    .split("\n")
    .filter((l) => l.trim() !== "" && !/^( Next|   [12]  )/.test(l));
  assert.deepEqual(calls, [
    "foreign_remove",
    "restart_docker",
    "up",
    "proxy_bound",
    "wait_for_proxy 60",
    "state takeover=removed",
    "post removed",
    "unit_remove",
  ]);
});

test("the unit runs this script as the worker and is enabled at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-unit-"));
  await writeFile(join(dir, "install.sh"), "#!/bin/bash\n", { mode: 0o700 });
  await writeFile(
    join(dir, "systemctl"),
    `#!/bin/bash\necho "$*" >> "$STUB_LOG"\n`,
    { mode: 0o755 },
  );
  const log = join(dir, "systemctl.log");
  const unit = join(dir, "unit.service");
  const out = await bash(
    `set -euo pipefail
exec 9>/dev/null
export STUB_LOG=${log}
DEPLO_DIR=${dir}; TAKEOVER_UNIT=${unit}; INSTALLER_URL=x
err() { echo "ERR $1"; }; note() { :; }
${await shellFn("install.sh", "takeover_unit_install")}
takeover_unit_install && echo installed
`,
    dir,
  );
  const text = await readFile(unit, "utf8");
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  await rm(dir, { recursive: true, force: true });
  assert.equal(out, "installed\n");
  assert.match(
    text,
    new RegExp(`ExecStart=${dir}/install.sh --takeover-worker`),
  );
  assert.match(text, /Restart=on-failure/);
  assert.match(text, /After=docker.service/);
  assert.deepEqual(calls, ["daemon-reload", "enable --now deplo-takeover"]);
});

test("the unit is refused when this script is not on the host to run later", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-unit-"));
  const out = await bash(`set -euo pipefail
exec 9>/dev/null
DEPLO_DIR=${dir}; TAKEOVER_UNIT=${dir}/unit.service; INSTALLER_URL=x
err() { echo "ERR: $1"; }; note() { :; }
${await shellFn("install.sh", "takeover_unit_install")}
takeover_unit_install || echo refused
`);
  await rm(dir, { recursive: true, force: true });
  assert.match(out, /^ERR: .*nothing can take the ports later/m);
  assert.match(out, /refused/);
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

  // An earlier install minted one carrying the host, which made Traefik skip
  // Let's Encrypt for it; an update re-mints that one.
  await bash(`openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
    -keyout ${dir}/default-key.pem -out ${dir}/default.pem -subj /CN=deplo-cb00710b.nip.io \
    -addext "subjectAltName=DNS:deplo-cb00710b.nip.io,IP:203.0.113.7" 2>/dev/null`);
  await bash(`set -euo pipefail\n${env}\n${fn}\nensure_default_cert`);
  assert.equal(await san(`${dir}/default.pem`), "IPAddress:203.0.113.7");
  await rm(dir, { recursive: true, force: true });
});

test("spin_ok renders the caller's detail AND the elapsed time", async () => {
  for (const file of ["install.sh", "install-agent.sh"]) {
    const out = await bash(`set -euo pipefail
UI_SPIN_MSG="the spinner's own message"
spin_elapsed() { printf '80s'; }
spin_kill() { :; }
ok() { printf '%s|%s\\n' "$1" "\${2:-}"; }
${await shellFn(file, "spin_ok")}
spin_ok "Old platform and its apps stopped" "nothing of it was removed"
spin_ok "no detail, only the clock"
`);
    assert.equal(
      out,
      "Old platform and its apps stopped|nothing of it was removed (80s)\n" +
        "no detail, only the clock|80s\n",
      `${file}: spin_ok dropped its second argument`,
    );
  }
});

/**
 * Four of the other platform's containers, two of them ALREADY STOPPED. The two
 * core ones answer to a name and to an id, which is what used to be counted twice.
 */
const DOCKER_STUB = `#!/bin/bash
S="$STUB_STATE"
NAMES="oldplatform oldplatform-db app-abc worker-xyz"
short() { case "$1" in oldplatform) echo 4fb8c486a61e ;; oldplatform-db) echo aaaaaaaaaaaa ;;
  app-abc) echo bbbbbbbbbbbb ;; worker-xyz) echo cccccccccccc ;; esac; }
name_of() { local n; for n in $NAMES; do
  case "$1" in "$n"|"$(short "$n")"*) echo "$n"; return 0 ;; esac; done; return 1; }
case "$1" in
  ps) case "$*" in *-aq*) for n in $NAMES; do short "$n"; done ;;
                   *) echo oldplatform; echo oldplatform-db ;; esac ;;
  inspect)
    shift; fmt=""; targets=""
    while [ $# -gt 0 ]; do case "$1" in --format) fmt="$2"; shift 2 ;;
      *) targets="$targets $1"; shift ;; esac; done
    for t in $targets; do n="$(name_of "$t")" || exit 1
      case "$fmt" in
        *.Id*) printf '%s%s\\n' "$(short "$n")" "0000000000000000000000000000000000000000000000000000" ;;
        *.managed*) echo true ;;
        *working_dir*) echo ;;
        *RestartPolicy*) printf '%s:%s\\n' "$(cat "$S/$n.pol")" "$(cat "$S/$n.run")" ;;
      esac; done ;;
  update) shift; pol="\${1#--restart=}"; shift
    for c in "$@"; do echo "$pol" > "$S/$(name_of "$c").pol"; done ;;
  stop)  shift; for c in "$@"; do echo 0 > "$S/$(name_of "$c").run"; done ;;
  start) shift; for c in "$@"; do echo 1 > "$S/$(name_of "$c").run"; done ;;
esac
exit 0
`;

const BEFORE = [
  ["oldplatform", "always", "1"],
  ["oldplatform-db", "always", "0"],
  ["app-abc", "unless-stopped", "1"],
  ["worker-xyz", "always", "0"],
];

test("the takeover stops each container once and rolls every policy back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-takeover-"));
  const state = join(dir, "state");
  await bash(`mkdir -p ${state}`);
  await writeFile(join(dir, "docker"), DOCKER_STUB, { mode: 0o755 });
  for (const [n, pol, run] of BEFORE) {
    await writeFile(join(state, `${n}.pol`), `${pol}\n`);
    await writeFile(join(state, `${n}.run`), `${run}\n`);
  }
  const fns = (
    await Promise.all(
      [
        "foreign_containers",
        "foreign_services",
        "foreign_workloads",
        "foreign_ids",
        "foreign_stop",
        "foreign_start",
      ].map((n) => shellFn("install.sh", n)),
    )
  ).join("\n");

  const out = await bash(
    `set -euo pipefail
export STUB_STATE=${state}
STATE_FILE=${dir}/state.env; DEPLO_DIR=${dir}; TAKEOVER=oldplatform
: > "$STATE_FILE"; exec 9>/dev/null
state_set() { printf '%s=%s\\n' "$1" "$2" >> "$STATE_FILE"; }
state_get() { sed -n "s/^$1=//p" "$STATE_FILE" | tail -n1; }
platform_dir() { printf '%s' "${dir}"; }
${fns}
echo "ids=$(foreign_ids | wc -l)"
foreign_stop
echo "recorded=$(state_get foreign_restart | wc -w)"
foreign_start
for n in ${BEFORE.map(([n]) => n).join(" ")}; do
  printf '%s:%s:%s\\n' "$n" "$(cat ${state}/$n.pol)" "$(cat ${state}/$n.run)"
done`,
    dir,
  );
  await rm(dir, { recursive: true, force: true });

  const lines = out.trim().split("\n");
  // Six entries for four containers is the name/id double count.
  assert.equal(lines[0], "ids=4");
  // Two of them were already down; recording only the running ones loses their policy.
  assert.equal(lines[1], "recorded=4");
  assert.deepEqual(
    lines.slice(2),
    BEFORE.map(([n, pol, run]) => `${n}:${pol}:${run}`),
    "a rollback must put every restart policy back and start only what was up",
  );
});

/** Every docker call the removal makes, in order. */
const REMOVE_STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_LOG"
cmd="$1"; shift
case "$cmd" in
  ps) case "$*" in *-aq*) echo aaaabbbbcccc ;; *) echo the-old-panel ;; esac ;;
  inspect)
    fmt=""
    while [ $# -gt 0 ]; do case "$1" in --format) fmt="$2"; shift 2 ;; *) shift ;; esac; done
    case "$fmt" in
      *.Id*) echo aaaabbbbcccc ;;
      *managed*) echo true ;;
      *working_dir*) echo ;;
      *.Mounts*) echo foreign-data; echo deplo-keep ;;
      *NetworkSettings*) echo old-panel-net; echo bridge ;;
    esac ;;
  service) case "$1" in ls) echo dokploy; echo dokploy-postgres ;; esac ;;
  images) echo dokploy/dokploy:latest; echo coollabsio/coolify:latest; echo myapp:latest ;;
esac
exit 0
`;

const REMOVAL_CASES = [
  {
    platform: "dokploy",
    label: "Dokploy",
    // https://docs.dokploy.com/docs/core/uninstall - the swarm is the one thing
    // a container sweep can never reach, and `ingress` only goes with it.
    expected: [
      "service rm dokploy dokploy-postgres",
      "swarm leave --force",
      "volume rm -f dokploy dokploy-postgres dokploy-redis",
      "network rm dokploy-network",
    ],
    key: false,
  },
  {
    platform: "coolify",
    label: "Coolify",
    expected: ["volume rm -f coolify-db coolify-redis", "network rm coolify"],
    // Its installer writes a key into root's authorized_keys; a removal that
    // leaves it there leaves a removed panel with root on the box.
    key: true,
  },
];

for (const c of REMOVAL_CASES) {
  test(`removing ${c.label} takes its own infrastructure too`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "deplo-remove-"));
    const log = join(dir, "docker.log");
    const platform = join(dir, "platform-dir");
    const keys = join(dir, ".ssh", "authorized_keys");
    await bash(`mkdir -p ${platform} ${dir}/.ssh && : > ${log}`);
    await writeFile(
      keys,
      "ssh-ed25519 AAAAmine admin@acme.com\nssh-ed25519 AAAAtheirs coolify\n",
    );
    await writeFile(join(dir, "docker"), REMOVE_STUB, { mode: 0o755 });

    const fns = (
      await Promise.all(
        [
          "foreign_containers",
          "foreign_services",
          "foreign_workloads",
          "foreign_ids",
          "platform_own_volumes",
          "platform_own_networks",
          "foreign_volumes_of",
          "foreign_networks_of",
          "foreign_remove",
        ].map((n) => shellFn("install.sh", n)),
      )
    ).join("\n");

    // `unset HOME`: the removal runs from a systemd unit, which sets none, and a
    // `set -u` script that reads it there ends at that line - the Coolify pass did.
    await bash(
      `set -euo pipefail
export STUB_LOG=${log}
unset HOME
TAKEOVER=${c.platform}; FOREIGN_LABEL=${c.label}; exec 9>/dev/null
blank() { :; }; phase() { :; }; step() { :; }; note() { :; }
spin_start() { :; }; spin_ok() { :; }
state_set() { :; }; takeover_post() { :; }
${fns.replaceAll("${HOME:-/root}", dir)}
platform_dir() { printf '%s' "${platform}"; }
foreign_remove`,
      dir,
    );

    const calls = (await readFile(log, "utf8")).trim().split("\n");
    const left = await readFile(keys, "utf8");
    await rm(dir, { recursive: true, force: true });

    for (const want of c.expected)
      assert.ok(
        calls.includes(want),
        `missing "${want}": ${calls.join(" | ")}`,
      );
    // Their uninstall prunes the whole daemon; here that is every app just migrated.
    assert.ok(
      !calls.some((x) => x.includes("prune")),
      "the removal must never prune the daemon",
    );
    // Read off the container, and Deplo's own volume filtered out of it.
    assert.ok(calls.includes("volume rm -f foreign-data"));
    assert.ok(!calls.some((x) => x.includes("deplo-keep")));
    assert.ok(!calls.some((x) => x.includes("myapp:latest")));
    assert.equal(
      left.includes("AAAAtheirs"),
      !c.key,
      "only the removed platform's own key comes out of authorized_keys",
    );
    assert.ok(left.includes("AAAAmine"), "nobody else's key is touched");
  });
}

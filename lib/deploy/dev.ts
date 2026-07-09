import "server-only";

import { readdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { decryptSecret } from "../crypto";
import { resolveEnvEntries } from "./env-resolve";
import { loadGlobalEnvForService } from "../data/global-env";
import { loadEnvironmentEnvForService } from "../data/environment-env";
import {
  loadEnvVarsForService,
  loadSharedEnvGroupsForService,
} from "../data/service-graph-load";
import { dataVolumeHostMountpoint } from "./builders";
import { devPresetImage } from "../frameworks";
import { rejectSymlinks } from "./upload";
import {
  certResolver,
  instanceHost,
  nipDomain,
  randomWords,
} from "./domains";
import { portFor } from "./ports";
import { traefikRouterLabels } from "./routing";
import type { DevConfig, Service } from "../types";

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const STACK_DIR = join(DATA_DIR, "stacks");
/** Persistent, bind-mounted workspaces, one dir per dev-enabled project. */
const DEV_DIR = join(DATA_DIR, "dev");
/** Where the bind-mounted dev entrypoint script lives (shipped once). */
const ENTRY_DIR = join(DEV_DIR, "_entry");
const ENTRY_PATH = join(ENTRY_DIR, "deplo-dev-entry");

/** Compose project / container name for a project's dev container. */
export function devServiceName(slug: string): string {
  return `deplo-dev-${slug}`;
}

/** Path of the rendered dev stack file. */
export function devStackFile(slug: string): string {
  return join(STACK_DIR, `dev-${slug}.yml`);
}

/** Host-side path of a project's persistent workspace dir. */
export function workspaceDir(slug: string): string {
  return join(DEV_DIR, slug);
}

/**
 * Workspace entries that are NOT the developer's source and must never enter a
 * production build context: the deps-volume mountpoint (node_modules — installed
 * deps live in a NAMED VOLUME never on the host bind, so they are reinstalled by
 * the build exactly like a normal deploy), the tunnel CLI/logs/pid (.deplo), the
 * fallback writable HOME (.deplo-home), and the git metadata (.git — excluded so
 * a user-mutated repo can never bake a re-tokenized origin or repo bloat into the
 * image). The same set gates `workspaceHasSource`, so a deploy and the
 * source-existence check can never disagree on what counts as source.
 */
const WORKSPACE_BUILD_EXCLUDE = new Set([
  "node_modules",
  ".deplo",
  ".deplo-home",
  ".git",
]);

/** Named volume backing node_modules / build caches (avoids bind slowness). */
function depsVolume(slug: string): string {
  return `deplo-dev-${slug}-deps`;
}

// `portFor` (the ADR-0001 port choke-point) now lives in ./ports and is
// re-exported here for the existing call sites that import it from this module.
export { portFor } from "./ports";

/**
 * The (label-only) preview URL of a dev container. Never a Domain. Prefers the
 * STORED preview host (the random-word hostname baked once at enableDev); when
 * absent (legacy row / dev never enabled) it derives a host for DISPLAY only —
 * the persisted value is written by the dev-start path, not here.
 */
export function devPreviewUrl(
  project: Pick<Service, "slug" | "dev">,
  ip = instanceHost(),
): string {
  const host = project.dev?.previewHost || newDevPreviewHost(project.slug, ip);
  return `https://${host}`;
}

/**
 * Resolve a project's dev config to the OFFICIAL base image it runs on
 * (ADR-0004). A custom image is used verbatim; a preset resolves through the
 * preset→base table.
 */
export function devImage(project: Service): string {
  const dev = project.dev;
  if (dev?.imageKind === "custom" && dev.image.trim()) return dev.image.trim();
  if (dev?.imageKind === "preset" && dev.image.trim()) {
    return devPresetImage(dev.image as Parameters<typeof devPresetImage>[0]);
  }
  return devPresetImage("node");
}

/**
 * Default DevConfig for a freshly-enabled project. Defaults to the `node` base
 * image and no dev command (the user picks their base image and runs their own
 * dev server); the dev port defaults to the production port; preview is ON.
 */
export function defaultDevConfig(project: Service): DevConfig {
  return {
    enabled: true,
    status: "off",
    imageKind: "preset",
    image: "node",
    devCommand: "",
    port: project.build.port,
    previewEnabled: true,
    // Generated + persisted when dev is enabled (enableDev); a freshly-derived
    // default config carries none yet.
    previewHost: null,
    latestStartAt: null,
  };
}

/** A fresh dev preview hostname for a project, with random words baked in:
 * `dev-<slug>-<adjective>-<animal>-<hexip>.nip.io`. Generated ONCE (at enableDev)
 * and persisted on the dev row; the stored value is read everywhere after. */
export function newDevPreviewHost(slug: string, ip = instanceHost()): string {
  return nipDomain(`dev-${slug}`, randomWords(), ip);
}

/**
 * Decrypted env for a dev container: per-project vars tagged `development`,
 * plus attached shared groups that target `development`. Shares the exact
 * `resolveEnvEntries` seam with the production stack — only the target differs —
 * so the two runtimes can never drift on what `development` inherits.
 */
async function devEnv(serviceId: string): Promise<Record<string, string>> {
  // env vars + attached shared groups are relational (cut-set c); load the
  // bounded set and decrypt at this edge (the `development` target).
  const [vars, groups, globals, environmentEnvs] = await Promise.all([
    loadEnvVarsForService(serviceId),
    loadSharedEnvGroupsForService(serviceId),
    loadGlobalEnvForService(serviceId),
    loadEnvironmentEnvForService(serviceId),
  ]);
  const out: Record<string, string> = {};
  for (const e of resolveEnvEntries(
    "development",
    serviceId,
    vars,
    groups,
    globals.teamGlobals,
    globals.instanceGlobals,
    environmentEnvs,
  )) {
    out[e.key] = decryptSecret(e.valueEnc);
  }
  return out;
}

/** Where the tokenized clone URL is staged (root-owned 0600, NOT in env). */
function cloneSecretPath(slug: string): string {
  return join(DEV_DIR, "_secrets", `${slug}.url`);
}

/**
 * Non-secret seed-source env for the dev container. The tokenized clone URL is
 * deliberately NOT returned here — it would land in `.Config.Env` (readable by
 * the dev user via `env`, and surfaced by `docker inspect`) and persist in the
 * stack file. The URL is staged to a root-owned 0600 file the entrypoint reads
 * (see writeCloneSecret); only the branch + source kind travel as env.
 */
function seedEnv(project: Service): Record<string, string> {
  if (project.source === "github" || project.source === "git") {
    if (project.repo) {
      return {
        DEPLO_DEV_SOURCE: "git",
        DEPLO_DEV_BRANCH: project.repo.branch || "main",
        // The entrypoint reads the TOKENIZED URL from this root-only file, not
        // from env. The TOKENLESS url is what gets persisted to .git/config.
        DEPLO_DEV_CLONE_URL_FILE: "/run/deplo/clone-url",
        DEPLO_DEV_REPO_URL: project.repo.url,
      };
    }
  }
  // No upstream — the entrypoint seeds an empty git workspace it can commit to
  // locally. A future archive-extract can key off DEPLO_DEV_SOURCE=upload.
  return { DEPLO_DEV_SOURCE: "upload" };
}

/**
 * Whether the workspace holds REAL source — any entry outside
 * WORKSPACE_BUILD_EXCLUDE. This is the gate for deploying FROM the workspace
 * (and the once-only seed check): there must be files on disk to build,
 * regardless of whether the dev container is currently running. A workspace that
 * holds only `.git` (a clone that failed → bare `git init`) reads as NO source,
 * so a "deploy from workspace" surfaces the friendly "start dev mode" error
 * instead of building an empty repo.
 */
export async function workspaceHasSource(slug: string): Promise<boolean> {
  try {
    const entries = await readdir(workspaceDir(slug));
    return entries.some((e) => !WORKSPACE_BUILD_EXCLUDE.has(e));
  } catch {
    return false; // dir missing → no source
  }
}

// seedUploadWorkspace moved AGENT-SIDE (Part D): the archive is tarred by the
// control plane (./agent-dev buildUploadTar) and shipped in the StartDev request;
// the agent extracts it into its own workspace host-side (clone-once). The
// control plane no longer touches the workspace filesystem for an upload seed.

/**
 * Copy a project's live dev workspace (/data/dev/<slug>) into `destDir` for a
 * PRODUCTION build, EXCLUDING the non-source entries (WORKSPACE_BUILD_EXCLUDE:
 * node_modules deps-volume mountpoint, .deplo tunnel state, .deplo-home, .git).
 *
 * The deplo PROCESS reads the workspace at its container-side path directly —
 * the copy is done by Node, not a docker bind — so workspaceDir(slug) is used
 * as-is with NO toHost translation (that exists only for `docker -v` args). The
 * process runs as root and the files are UID 1000, so they are readable.
 *
 * SECURITY: the workspace is fully developer-controlled (UID 1000, shell/SSH/VS
 * Code access), so it is treated EXACTLY like an uploaded archive — after the
 * copy we `rejectSymlinks(destDir)` (the same guard extractArchive runs). A
 * plain recursive `cp` preserves symlinks (dereference:false), so without this a
 * planted `leak -> /data/dev/_secrets/<slug>.url` (or `-> /`, `-> /proc/1/...`)
 * plus a `COPY leak …` in the Dockerfile would bake a host secret into the
 * user's own image. Rejecting — not following, not preserving — is the fix.
 *
 * Returns `destDir` (the populated build root) so the caller can resolve
 * rootDirectory against it, mirroring extractArchive's return shape. Throws if
 * the workspace is missing or holds no real source.
 */
export async function copyWorkspaceForBuild(
  slug: string,
  destDir: string,
  log: (line: string) => void = () => {},
): Promise<string> {
  const ws = workspaceDir(slug);
  let entries: string[];
  try {
    entries = await readdir(ws);
  } catch {
    throw new Error(
      "Dev workspace not found — start the dev container before deploying from it",
    );
  }
  const sources = entries.filter((e) => !WORKSPACE_BUILD_EXCLUDE.has(e));
  if (sources.length === 0) {
    throw new Error("Dev workspace is empty — nothing to deploy");
  }
  // Per-entry cp: the excluded names are all top-level, so copying entry-by-entry
  // keeps the skip list trivial without dereferencing or filtering mid-walk.
  for (const e of sources) {
    log(`copy ${e}`);
    await cp(join(ws, e), join(destDir, e), { recursive: true });
  }
  // Treat the developer's tree as attacker-controlled — same as an upload.
  await rejectSymlinks(destDir);
  return destDir;
}

/** YAML-escape a string value for an `environment:` map entry. */
function yamlValue(v: string): string {
  return JSON.stringify(v);
}

/**
 * Render the dev container's compose file (project `deplo-dev-<slug>`). An
 * official base image, a persistent `/workspace` bind, the bind-mounted dev
 * entrypoint, a deps volume, and — when preview is on — a LABEL-only Traefik
 * route to the stored `dev-<slug>-<words>-<hexip>.nip.io` preview host (never a
 * Domain row). Ports are NOT published: Traefik fronts HTTP, SSH via the gateway.
 */
export async function renderDevCompose(project: Service): Promise<string> {
  const slug = project.slug;
  const name = devServiceName(slug);
  const port = portFor(project, "development");
  const image = devImage(project);

  const mountpoint = await dataVolumeHostMountpoint();
  const toHost = (p: string): string =>
    mountpoint && p.startsWith(DATA_DIR)
      ? join(mountpoint, p.slice(DATA_DIR.length))
      : p;
  const wsHost = toHost(workspaceDir(slug));
  const entryHost = toHost(ENTRY_PATH);
  const isGit =
    (project.source === "github" || project.source === "git") && project.repo;
  const secretHost = toHost(cloneSecretPath(slug));

  // The STORED preview host (random words baked once at enableDev). Resolved
  // ONCE here and reused for both the env var and the Traefik router label, so
  // the two can never disagree. Falls back to a derived host if a legacy row has
  // none (startDevContainer heals it before this, so the fallback is defensive).
  const previewHost =
    project.dev?.previewHost || newDevPreviewHost(slug, instanceHost());
  const env: Record<string, string> = {
    // PORT is the routed preview port; the user binds their manual dev server
    // to it. The container does NOT auto-run a dev command.
    PORT: String(port),
    // The preview hostname a Vite/Astro dev server must allow (DNS-rebinding
    // protection 403s unknown Host headers behind Traefik). Surfaced in the
    // login profile so the user can pass --allowed-hosts "$DEPLO_DEV_PREVIEW_HOST".
    DEPLO_DEV_PREVIEW_HOST: previewHost,
    ...seedEnv(project),
    ...(await devEnv(project.id)),
  };
  const envYaml = Object.entries(env)
    .map(([k, v]) => `      ${k}: ${yamlValue(v)}`)
    .join("\n");

  const labels = [
    "deplo.managed=true",
    `deplo.project=${project.id}`,
    `deplo.slug=${slug}`,
    "deplo.role=dev",
  ];
  if (project.dev?.previewEnabled !== false) {
    // LABEL-only preview route, via the shared routing module. Distinct router
    // key + distinct host from the production router, so the two never share a
    // Host() rule. Dev pins the deplo `docker.network` and always names its
    // service (it's a single router on its own host). Reuse the SAME resolved
    // host as the env var above so the route and the URL the user is told always
    // match (the words are random — recomputing would diverge).
    const router = `deplo-dev-${slug}`;
    labels.push(
      ...traefikRouterLabels({
        baseKey: router,
        routes: [{ name: previewHost, port: null }],
        defaultPort: port,
        certResolver: certResolver(),
        dockerNetwork: "deplo",
        alwaysService: true,
      }),
    );
  }
  const labelsYaml = labels.map((l) => `      - "${l}"`).join("\n");

  return `# Generated by Deplo  dev-${slug}
services:
  ${name}:
    image: ${image}
    container_name: ${name}
    restart: unless-stopped
    working_dir: /workspace
    tty: true
    stdin_open: true
    entrypoint: ["/bin/sh", "/usr/local/bin/deplo-dev-entry"]
    networks:
      - deplo
    environment:
${envYaml}
    volumes:
      - ${JSON.stringify(`${wsHost}:/workspace`)}
      - ${JSON.stringify(`${depsVolume(slug)}:/workspace/node_modules`)}
      - ${JSON.stringify(`${entryHost}:/usr/local/bin/deplo-dev-entry:ro`)}${
        isGit
          ? `\n      - ${JSON.stringify(`${secretHost}:/run/deplo/clone-url:ro`)}`
          : ""
      }
    labels:
${labelsYaml}

volumes:
  ${depsVolume(slug)}:
    name: ${depsVolume(slug)}

networks:
  deplo:
    external: true
`;
}

/**
 * The dev container's entrypoint, bind-mounted from /data and run as root, then
 * dropped to `devuser` (UID 1000). Seeds the workspace ONCE (clone for git,
 * empty git-init for upload) — never auto-pulls over user edits — installs git +
 * deps if missing, ensures devuser owns /workspace, then `exec`s the dev command
 * AS devuser so hot reload streams and bind-mount file ownership stays sane.
 *
 * Versioned string constant; rewritten by ensureDevEntry() on every start so a
 * Deplo upgrade ships a new entrypoint without rebuilding anything (ADR-0004).
 */
const DEV_ENTRY_SCRIPT = `#!/bin/sh
# Generated by Deplo — dev container entrypoint. Runs as root, drops to devuser.
set -eu

WS=/workspace
DEV_UID=1000
DEV_USER=devuser

log() { printf '[deplo-dev] %s\\n' "$1" >&2; }

# --- ensure git + bash + sftp-server are present (official base images vary) --
# bash is the SSH login shell; sftp-server backs SFTP + the VS Code file
# explorer. Neither is guaranteed in language base images — install once (they
# persist thereafter on the bind-mounted/deps layers).
have_sftp() {
  for s in /usr/lib/openssh/sftp-server /usr/libexec/sftp-server \\
           /usr/lib/ssh/sftp-server /usr/lib/sftp-server; do
    [ -x "$s" ] && return 0
  done
  command -v sftp-server >/dev/null 2>&1
}
if ! command -v git >/dev/null 2>&1 || ! command -v bash >/dev/null 2>&1 || ! have_sftp; then
  log "installing dev tooling (git, bash, sftp-server)…"
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache git bash openssh-client openssh-sftp-server >/dev/null 2>&1 || true
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update >/dev/null 2>&1 \\
      && apt-get install -y --no-install-recommends git bash ca-certificates openssh-sftp-server >/dev/null 2>&1 || true
  fi
fi

# --- ensure devuser (UID 1000) exists ----------------------------------------
if ! id "$DEV_USER" >/dev/null 2>&1; then
  if id "$DEV_UID" >/dev/null 2>&1; then
    # UID 1000 already taken (e.g. node:* ships a 'node' user) — reuse it.
    DEV_USER=$(getent passwd "$DEV_UID" | cut -d: -f1)
  elif command -v adduser >/dev/null 2>&1 && command -v apk >/dev/null 2>&1; then
    adduser -D -u "$DEV_UID" "$DEV_USER" >/dev/null 2>&1 || true
  elif command -v useradd >/dev/null 2>&1; then
    useradd -m -u "$DEV_UID" "$DEV_USER" >/dev/null 2>&1 || true
  fi
fi

mkdir -p "$WS"

# --- seed the workspace ONCE (never auto-pull over edits) ---------------------
# /workspace/node_modules is a NAMED VOLUME mounted on top of the bind mount, so
# the workspace is "empty" iff it has no .git AND nothing but that mountpoint. We
# can't 'git clone' into the non-empty /workspace; clone to a temp dir and move
# the tree in (leaving the node_modules mount untouched).
is_seeded() { [ -e "$WS/.git" ]; }
ws_empty() {
  # True when the only entries (if any) are NON-source dirs that legitimately
  # live in the bind-mounted workspace and persist across restarts: the
  # node_modules deps-volume mountpoint, the VS Code tunnel state (.deplo) and
  # the dropped user's writable HOME (.deplo-home). This list MUST stay in sync
  # with WORKSPACE_BUILD_EXCLUDE (host side) — if it drifts, the tunnel/HOME
  # dirs make the workspace look non-empty and seeding is silently skipped,
  # leaving the user with only .deplo + node_modules and no source.
  for e in "$WS"/* "$WS"/.[!.]*; do
    [ -e "$e" ] || continue
    case "$e" in
      "$WS/node_modules"|"$WS/.deplo"|"$WS/.deplo-home") continue ;;
    esac
    return 1
  done
  return 0
}

if ! is_seeded && ws_empty; then
  case "\${DEPLO_DEV_SOURCE:-upload}" in
    git)
      # The tokenized clone URL is read from a root-only 0600 file (never an env
      # var / inspect-able), then we DROP it from the shell so it can't leak.
      CLONE_URL=""
      if [ -n "\${DEPLO_DEV_CLONE_URL_FILE:-}" ] && [ -r "\${DEPLO_DEV_CLONE_URL_FILE}" ]; then
        CLONE_URL=$(cat "\${DEPLO_DEV_CLONE_URL_FILE}")
      fi
      if [ -n "$CLONE_URL" ]; then
        log "cloning \${DEPLO_DEV_BRANCH:-main}…"
        TMP=$(mktemp -d)
        if git clone --branch "\${DEPLO_DEV_BRANCH:-main}" --single-branch \\
              "$CLONE_URL" "$TMP" 2>/dev/null \\
            || git clone "$CLONE_URL" "$TMP" 2>/dev/null; then
          # SCRUB the token before /workspace becomes user-readable: 'git clone'
          # persists the tokenized URL verbatim into .git/config (and reflogs),
          # and we chown /workspace to UID 1000 below — which is exactly the UID
          # every dev SSH user lands as. Rewrite origin to the TOKENLESS url so
          # the dev user can never read the GitHub installation token from
          # .git/config. (The token also stays out of env/inspect via the 0600
          # file.) Drop FETCH_HEAD/packed-refs that could embed it too.
          if [ -n "\${DEPLO_DEV_REPO_URL:-}" ]; then
            git -C "$TMP" remote set-url origin "$DEPLO_DEV_REPO_URL" 2>/dev/null || true
          else
            git -C "$TMP" remote remove origin 2>/dev/null || true
          fi
          rm -f "$TMP/.git/FETCH_HEAD" 2>/dev/null || true
          # Move the cloned tree into /workspace WITHOUT touching the node_modules
          # volume mountpoint (a committed node_modules must not poison the cache).
          for e in "$TMP"/* "$TMP"/.[!.]*; do
            [ -e "$e" ] || continue
            case "$e" in "$TMP/node_modules") continue ;; esac
            cp -a "$e" "$WS/" 2>/dev/null || true
          done
        else
          log "clone failed — leaving an empty git workspace"
          git -C "$WS" init >/dev/null 2>&1 || true
        fi
        rm -rf "$TMP" 2>/dev/null || true
        CLONE_URL=""
      fi
      ;;
    upload)
      log "initialising empty workspace (upload source)…"
      git -C "$WS" init >/dev/null 2>&1 || true
      ;;
  esac
fi

# --- install deps if missing (best-effort; only on first boot) ----------------
if [ -f "$WS/package.json" ] && [ ! -d "$WS/node_modules/.bin" ]; then
  log "installing dependencies…"
  cd "$WS"
  if command -v bun >/dev/null 2>&1; then bun install || true
  elif command -v npm >/dev/null 2>&1; then npm install || true
  fi
fi

# --- ensure devuser owns the workspace (incl. the deps volume) ----------------
chown -R "$DEV_UID":"$DEV_UID" "$WS" 2>/dev/null || true

# --- prepare the dev user's interactive environment ---------------------------
# We do NOT auto-run a dev server. The container holds open and the developer
# runs their dev command by hand over SSH / the VS Code terminal — they control
# when and how it starts (and on which port). Traefik still routes the preview
# to \$PORT, so the user binds e.g. 'vite --host 0.0.0.0 --port \$PORT'.
cd "$WS"

# A writable HOME for the dropped UID-1000 user (setpriv/su don't reset HOME, so
# it would stay /root and dev tools that write \$HOME/.config|.cache fail EACCES).
DEV_HOME=$(getent passwd "$DEV_UID" 2>/dev/null | cut -d: -f6)
[ -n "$DEV_HOME" ] && [ "$DEV_HOME" != "/" ] || DEV_HOME="$WS/.deplo-home"
mkdir -p "$DEV_HOME" 2>/dev/null || true
chown "$DEV_UID":"$DEV_UID" "$DEV_HOME" 2>/dev/null || true

# A login profile so EVERY interactive shell (SSH, console) gets the project's
# node_modules/.bin on PATH, a writable HOME, and \$PORT — without the user
# re-exporting them each time. Written where bash/sh login shells read it.
BINPATH="$WS/node_modules/.bin"
PROFILE="$DEV_HOME/.deplo-profile"
cat > "$PROFILE" <<PROFILE_EOF
export PATH="$BINPATH:\\$PATH"
export HOME="$DEV_HOME"
export XDG_CONFIG_HOME="$DEV_HOME/.config"
export XDG_CACHE_HOME="$DEV_HOME/.cache"
export PORT="\${PORT:-3000}"
export DEPLO_DEV_PREVIEW_HOST="\${DEPLO_DEV_PREVIEW_HOST:-}"
cd "$WS" 2>/dev/null || true
PROFILE_EOF
# Source the profile from bash + sh login files so it always applies.
for rc in "$DEV_HOME/.bashrc" "$DEV_HOME/.bash_profile" "$DEV_HOME/.profile"; do
  if [ ! -f "$rc" ] || ! grep -q deplo-profile "$rc" 2>/dev/null; then
    echo '[ -f "$HOME/.deplo-profile" ] && . "$HOME/.deplo-profile"' >> "$rc"
  fi
done
chown "$DEV_UID":"$DEV_UID" "$PROFILE" "$DEV_HOME"/.bashrc "$DEV_HOME"/.bash_profile "$DEV_HOME"/.profile 2>/dev/null || true

log "workspace ready — SSH in and run your dev command (e.g. 'npm run dev'). Port \${PORT:-3000} is routed to the preview URL."

# Hold the container open as the dev user (UID 1000). The dev server is started
# manually by the developer; this process just keeps the container alive.
HOLD="export HOME=$DEV_HOME; exec tail -f /dev/null"
if command -v su-exec >/dev/null 2>&1; then
  exec su-exec "$DEV_UID" sh -lc "$HOLD"
elif command -v gosu >/dev/null 2>&1; then
  exec gosu "$DEV_UID" sh -lc "$HOLD"
elif command -v setpriv >/dev/null 2>&1; then
  exec setpriv --reuid "$DEV_UID" --regid "$DEV_UID" --init-groups sh -lc "$HOLD"
else
  exec su "$DEV_USER" -c "$HOLD"
fi
`;

/** The rendered dev entrypoint script (Part D: the AGENT writes it to its own
 *  bind mount, so the control plane only RENDERS it here — single source of truth,
 *  rewritten each start so a Deplo upgrade ships a new entrypoint, ADR-0004). */
export function devEntryScript(): string {
  return DEV_ENTRY_SCRIPT;
}

// ---------------------------------------------------------------------------
// PART D: the dev-container LIFECYCLE (start / stop / reset / teardown) and the
// VS Code tunnel exec moved to the per-host agent — once a project can live on a
// remote server, its dev container + tunnel must run THERE (ADR-0002 singletons).
// The control plane keeps ALL the RENDERING above (renderDevCompose, the
// entrypoint script, the tunnel launch script, the clone-URL minting) as the
// single source of truth (D2/D4); the agent owns the host-coupled half. The
// lifecycle entry points now live in ./agent-dev (agentStartDev / agentStopDev /
// agentResetDevWorkspace / agentTeardownDev / the agent tunnel fns), the dev-mode
// twin of ./agent-deploy. dev.ts is now pure renderers + the build-context
// helpers below (copyWorkspaceForBuild / workspaceHasSource), which feed the
// "deploy from dev workspace" path (a localhost build reads the workspace
// directly; a remote build uses SOURCE_KIND_DEV_WORKSPACE on the agent).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// VS Code Remote Tunnel — the editor integration for an exec-only gateway.
//
// VS Code Remote-SSH cannot work through the gateway (it must forward to a
// server port living in the CONTAINER netns, unreachable from the gateway —
// and enabling forwarding would expose the docker socket-proxy). Instead we run
// `code tunnel` INSIDE the dev container: it dials OUT to Microsoft's relay over
// HTTPS, so there is no inbound port and no gateway change. The user authorizes
// once via a GitHub/Microsoft device code, then opens https://vscode.dev/tunnel/<name>.
// ---------------------------------------------------------------------------

/** Stable tunnel machine name for a project (also the vscode.dev path). */
function tunnelName(slug: string): string {
  return `deplo-${slug}`;
}

/** In-container paths for the CLI + the tunnel's log/pid (under the workspace). */
const TUNNEL_DIR = "/workspace/.deplo";
const TUNNEL_LOG = `${TUNNEL_DIR}/tunnel.log`;
const TUNNEL_PID = `${TUNNEL_DIR}/tunnel.pid`;
const CODE_CLI = `${TUNNEL_DIR}/code`;
/**
 * Where the CLI keeps its metadata — INCLUDING the GitHub/Microsoft auth token.
 * It defaults to `$HOME/.vscode-cli`, which for most base images is outside
 * /workspace (e.g. /home/node) and therefore in the container's EPHEMERAL writable
 * layer — destroyed by `compose down` on Stop, so every restart re-prompts the
 * device login. Pinning it inside /workspace/.deplo (bind-mounted to
 * /data/dev/<slug> on the host) makes the login survive stop/start: authorize once.
 */
const CLI_DATA_DIR = `${TUNNEL_DIR}/cli-data`;

/**
 * Bootstrap-and-launch script run (detached) inside the dev container. Downloads
 * the VS Code CLI once, then starts `code tunnel` writing to TUNNEL_LOG. Run as
 * the dev user so the tunnel (and any edits it makes) are UID 1000.
 */
export function tunnelLaunchScript(slug: string): string {
  return `set -e
mkdir -p ${TUNNEL_DIR} ${CLI_DATA_DIR}
# Already running? leave it.
if [ -f ${TUNNEL_PID} ] && kill -0 "$(cat ${TUNNEL_PID} 2>/dev/null)" 2>/dev/null; then
  echo "tunnel already running"; exit 0
fi
# Download the CLI once (alpine vs glibc) INTO .deplo, but keep the tunnel's
# default folder = the project root.
if [ ! -x ${CODE_CLI} ]; then
  ( cd ${TUNNEL_DIR}
    url="https://update.code.visualstudio.com/latest/cli-linux-x64/stable"
    [ -f /etc/alpine-release ] && url="https://update.code.visualstudio.com/latest/cli-alpine-x64/stable"
    (curl -Lsk "$url" -o cli.tgz || wget -qO cli.tgz "$url") 2>/dev/null
    tar -xf cli.tgz 2>/dev/null && rm -f cli.tgz )
fi
: > ${TUNNEL_LOG}
# Launch detached FROM /workspace so the editor opens the project root, not the
# hidden .deplo dir (the CLI uses its cwd as the default folder). --cli-data-dir
# pins the auth token inside the persisted workspace (see CLI_DATA_DIR) so a
# stop/start does NOT re-prompt the GitHub device login — authorize once.
cd /workspace
setsid ${CODE_CLI} tunnel --cli-data-dir ${CLI_DATA_DIR} \\
  --accept-server-license-terms --name ${tunnelName(slug)} \\
  >> ${TUNNEL_LOG} 2>&1 < /dev/null &
echo $! > ${TUNNEL_PID}
echo "tunnel launched"`;
}

export interface VscodeTunnelInfo {
  /** The tunnel process is alive (may still be waiting for authorization). */
  running: boolean;
  /** The tunnel is authorized AND connected to the relay (editor URL usable). */
  connected: boolean;
  /** The GitHub/Microsoft device-login URL the user must visit (until authed). */
  loginUrl: string | null;
  /** The device code to enter at loginUrl. */
  loginCode: string | null;
  /** The editor URL — ONLY set once connected (else null; never guessed). */
  tunnelUrl: string | null;
  /** Raw tail of the tunnel log, for diagnostics. */
  log: string;
}

/**
 * Parse the tunnel log. The editor URL is surfaced ONLY when the CLI has
 * actually connected (it prints "Open this link …vscode.dev/tunnel/…") — never
 * guessed, because the tunnel name isn't registered with the relay until the
 * device-code authorization completes, and a guessed URL 404s ("tunnel not
 * found"). A pending device-login line means NOT yet connected.
 */
export function parseTunnelLog(log: string): {
  connected: boolean;
  loginUrl: string | null;
  loginCode: string | null;
  tunnelUrl: string | null;
} {
  // "…please log into https://github.com/login/device and use code 326E-0CF5"
  const login = log.match(/log into (https:\/\/\S+) and use code (\S+)/i);
  // Printed only after auth completes + the tunnel registers with the relay.
  const open = log.match(/(https:\/\/vscode\.dev\/tunnel\/\S+)/i);
  // Whether the most-recent state is "waiting for auth" (a device code is the
  // last meaningful event) vs connected.
  const connected = Boolean(open);
  return {
    connected,
    // Hide the login prompt once connected (it's stale).
    loginUrl: connected ? null : (login?.[1] ?? null),
    loginCode: connected ? null : (login?.[2] ?? null),
    tunnelUrl: open?.[1] ?? null,
  };
}

// The tunnel exec wrappers (getVscodeTunnel / startVscodeTunnel /
// stopVscodeTunnel) moved to ./agent-dev (agentGetTunnel / agentStartTunnel /
// agentStopTunnel) — they `docker exec` into the dev container, which now runs on
// the owning agent's host. The TUNNEL_* in-container paths + the launch script +
// parseTunnelLog stay here as the single rendering/parsing source of truth.

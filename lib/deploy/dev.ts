import "server-only";

import { mkdir, rm, writeFile, chmod, readdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { read } from "../store";
import { decryptSecret } from "../crypto";
import { docker } from "../infra/docker";
import { dataVolumeHostMountpoint } from "./builders";
import {
  devCommandFor,
  devImagePresetFor,
  devPresetImage,
} from "../frameworks";
import { installationCloneUrl } from "../github/app";
import { extractArchive, rejectSymlinks } from "./upload";
import { ensureGateway } from "../infra/ssh-gateway";
import { certResolver, instanceHost, sslipDomain } from "./domains";
import { portFor } from "./ports";
import { traefikRouterLabels } from "./routing";
import type { DevConfig, Project } from "../types";

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const STACK_DIR = join(DATA_DIR, "stacks");
/** Persistent, bind-mounted workspaces, one dir per dev-enabled project. */
const DEV_DIR = join(DATA_DIR, "dev");
/** Where the bind-mounted dev entrypoint script lives (shipped once). */
const ENTRY_DIR = join(DEV_DIR, "_entry");
const ENTRY_PATH = join(ENTRY_DIR, "deplo-dev-entry");

/** Compose project / container name for a project's dev container. */
export function devProjectName(slug: string): string {
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

/** The computed (label-only) preview URL of a dev container. Never a Domain. */
export function devPreviewUrl(slug: string, ip = instanceHost()): string {
  return `https://${sslipDomain(`dev-${slug}`, ip)}`;
}

/**
 * Resolve a project's dev config to the OFFICIAL base image it runs on
 * (ADR-0004). A custom image is used verbatim; a preset resolves through the
 * preset→base table.
 */
export function devImage(project: Project): string {
  const dev = project.dev;
  if (dev?.imageKind === "custom" && dev.image.trim()) return dev.image.trim();
  if (dev?.imageKind === "preset" && dev.image.trim()) {
    return devPresetImage(dev.image as Parameters<typeof devPresetImage>[0]);
  }
  return devPresetImage(devImagePresetFor(project.framework));
}

/**
 * Default DevConfig for a freshly-enabled project. The image preset is derived
 * from `framework`; the dev command from the framework's `dev` command; the
 * dev port defaults to the production port; preview is ON by default.
 */
export function defaultDevConfig(project: Project): DevConfig {
  return {
    enabled: true,
    status: "off",
    imageKind: "preset",
    image: devImagePresetFor(project.framework),
    devCommand: devCommandFor(project.framework),
    port: project.build.port,
    previewEnabled: true,
    latestStartAt: null,
  };
}

/**
 * Decrypted env for a dev container. STRICTER than `projectEnv`: only
 * per-project vars tagged `development`, and explicitly NO shared env groups
 * (those have no target axis and flow only to the production stack). Empty by
 * default — the user adds `development` vars by hand.
 */
function devEnv(projectId: string): Record<string, string> {
  const d = read();
  const out: Record<string, string> = {};
  for (const e of d.envVars) {
    if (e.projectId === projectId && e.targets.includes("development")) {
      out[e.key] = decryptSecret(e.valueEnc);
    }
  }
  // Deliberately NO sharedEnvGroups — see CONTEXT.md "Shared env group".
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
function seedEnv(project: Project): Record<string, string> {
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
 * Stage the tokenized clone URL to a root-owned 0600 file bind-mounted into the
 * container at /run/deplo/clone-url (outside /workspace). The dev user (UID
 * 1000) cannot read it and it never appears in the container env / inspect /
 * stack file. Removed when not a git source.
 */
async function writeCloneSecret(project: Project): Promise<void> {
  const path = cloneSecretPath(project.slug);
  await mkdir(join(DEV_DIR, "_secrets"), { recursive: true });
  if ((project.source === "github" || project.source === "git") && project.repo) {
    let url = project.repo.url;
    try {
      // Mint a tokenized URL for private GitHub repos. If the installation is
      // missing/stale (or this is a public/plain-git repo), fall back to the
      // plain URL rather than failing the whole start — a public clone still
      // succeeds, and a private one degrades to an empty git workspace the user
      // can re-point, instead of a hard error on Start.
      url = await installationCloneUrl(
        project.repo.url,
        project.repo.installationId ?? null,
      );
    } catch {
      url = project.repo.url;
    }
    // 0600 root-owned: the dev user inside the container cannot read it.
    await writeFile(path, url, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => {});
  } else {
    await rm(path, { force: true }).catch(() => {});
  }
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

/**
 * Seed an `upload`-source workspace HOST-SIDE (the archive lives under
 * /data/uploads and is not mounted in the container, and the secure extract —
 * zip-slip + symlink guards + single-root collapse — already exists for the
 * production path). Only runs when the workspace is empty, mirroring the
 * clone-once semantics: user edits are never clobbered. The entrypoint's `git
 * init` then makes it a local repo. No-op when there is no archive yet.
 */
async function seedUploadWorkspace(project: Project): Promise<void> {
  if (project.source !== "upload" || !project.upload) return;
  if (await workspaceHasSource(project.slug)) return;
  const ws = workspaceDir(project.slug);
  await mkdir(ws, { recursive: true });
  // Extract to a temp dir, then copy the (single-root-collapsed) tree into the
  // workspace without disturbing the node_modules / .deplo mountpoints.
  const tmp = join(DEV_DIR, "_extract", project.slug);
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  await mkdir(tmp, { recursive: true });
  try {
    const root = await extractArchive(project.upload, tmp, () => {});
    for (const e of await readdir(root)) {
      await cp(join(root, e), join(ws, e), { recursive: true }).catch(() => {});
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

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
 * route to `dev-<slug>.<ip>.sslip.io` (never a Domain row). Ports are NOT
 * published: Traefik fronts HTTP, SSH comes via the gateway.
 */
export async function renderDevCompose(project: Project): Promise<string> {
  const slug = project.slug;
  const name = devProjectName(slug);
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

  const previewHost = sslipDomain(`dev-${slug}`, instanceHost());
  const env: Record<string, string> = {
    // PORT is the routed preview port; the user binds their manual dev server
    // to it. The container does NOT auto-run a dev command.
    PORT: String(port),
    // The preview hostname a Vite/Astro dev server must allow (DNS-rebinding
    // protection 403s unknown Host headers behind Traefik). Surfaced in the
    // login profile so the user can pass --allowed-hosts "$DEPLO_DEV_PREVIEW_HOST".
    DEPLO_DEV_PREVIEW_HOST: previewHost,
    ...seedEnv(project),
    ...devEnv(project.id),
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
    // service (it's a single router on its own host).
    const host = sslipDomain(`dev-${slug}`, instanceHost());
    const router = `deplo-dev-${slug}`;
    labels.push(
      ...traefikRouterLabels({
        baseKey: router,
        routes: [{ name: host, port: null }],
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
  # True when the only entry (if any) is the node_modules volume mountpoint.
  for e in "$WS"/* "$WS"/.[!.]*; do
    [ -e "$e" ] || continue
    case "$e" in "$WS/node_modules") continue ;; esac
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

/** Write the bind-mounted dev entrypoint (idempotent; overwrites on upgrade). */
export async function ensureDevEntry(): Promise<void> {
  await mkdir(ENTRY_DIR, { recursive: true });
  await writeFile(ENTRY_PATH, DEV_ENTRY_SCRIPT, { mode: 0o755 });
  await chmod(ENTRY_PATH, 0o755).catch(() => {});
}

/**
 * Start (or restart) a project's dev container. Ensures the gateway + entrypoint
 * + workspace dir exist (chowned 1000), renders + writes the stack, `compose up
 * -d`. First start seeds the workspace; later starts reuse it (edits intact).
 * Does NOT create a Domain row — the preview is a label.
 */
export async function startDev(project: Project): Promise<void> {
  const slug = project.slug;
  await mkdir(STACK_DIR, { recursive: true });
  await ensureDevEntry();
  await ensureGateway();

  const ws = workspaceDir(slug);
  await mkdir(ws, { recursive: true });
  // Pre-chown so the dev server (UID 1000) and the developer never fight over
  // ownership across the bind mount. Best-effort: the entrypoint re-chowns too.
  await docker(["run", "--rm", "-v", `${await hostWorkspaceMount(slug)}`, "alpine", "chown", "1000:1000", "/workspace"], {
    timeout: 30_000,
  }).catch(() => {});

  // Stage the tokenized clone URL to a root-only 0600 file (never in env).
  await writeCloneSecret(project);
  // For an `upload` source, extract the archive into the (empty) workspace
  // host-side before the container starts — the archive isn't mounted in the
  // container, so the entrypoint can't reach it. (git/github seed in-container.)
  await seedUploadWorkspace(project);

  const stackFile = devStackFile(slug);
  const yaml = await renderDevCompose(project);
  // 0600: the stack file holds decrypted `development` env vars; keep it as
  // tight as the production env-file (build.ts writes its env-file 0600 too).
  await writeFile(stackFile, yaml, { mode: 0o600 });

  await docker(
    ["compose", "-p", devProjectName(slug), "-f", stackFile, "up", "-d", "--remove-orphans"],
    { timeout: 600_000 },
  );
}

/**
 * DESTRUCTIVE: reset a project's workspace to a fresh copy of the CURRENT deploy
 * source. Stops the container, wipes the workspace dir AND the deps volume (so a
 * source change doesn't leave stale files or node_modules), then `startDev`
 * reseeds from scratch — the entrypoint clones/extracts the current source into
 * the now-empty workspace. Any uncommitted edits in the old workspace are lost.
 */
export async function resetDevWorkspace(project: Project): Promise<void> {
  const slug = project.slug;
  // 1. Stop the container so nothing holds the bind mount / writes during wipe.
  await stopDev(slug).catch(() => {});
  // 2. Wipe the workspace contents (keep the dir — it's the bind target). Files
  //    created inside as UID 1000 are removable by root (the Deplo app is root).
  const ws = workspaceDir(slug);
  await rm(ws, { recursive: true, force: true }).catch(() => {});
  await mkdir(ws, { recursive: true });
  // 3. Drop the deps volume so dependencies are reinstalled for the new source.
  await docker(["volume", "rm", "-f", depsVolume(slug)], {
    timeout: 30_000,
  }).catch(() => {});
  // 4. Reseed: startDev re-stages a fresh clone token and the entrypoint clones
  //    the CURRENT source into the empty workspace.
  await startDev(project);
}

/** The `-v host:/workspace` arg for the pre-chown helper container. */
async function hostWorkspaceMount(slug: string): Promise<string> {
  const mountpoint = await dataVolumeHostMountpoint();
  const ws = workspaceDir(slug);
  const host =
    mountpoint && ws.startsWith(DATA_DIR)
      ? join(mountpoint, ws.slice(DATA_DIR.length))
      : ws;
  return `${host}:/workspace`;
}

/**
 * Stop a project's dev container (reversible). KEEPS the workspace dir and the
 * deps volume so a later `startDev` resumes the edited tree.
 */
export async function stopDev(slug: string): Promise<void> {
  const stackFile = devStackFile(slug);
  // Stop the VS Code tunnel FIRST, while the container is still up. `compose
  // down` would kill the tunnel PROCESS, but the machine stays registered on the
  // relay (reconnectable on vscode.dev for the grace period) and the PID file
  // lingers in the persisted workspace. `tunnel kill` unregisters cleanly and
  // clears the PID; it keeps the auth token, so a later Start re-uses the login.
  // noThrow/.catch inside, so a missing/never-tunnelled container is a no-op.
  await stopVscodeTunnel(slug).catch(() => {});
  await docker(
    ["compose", "-p", devProjectName(slug), "-f", stackFile, "down", "--remove-orphans"],
    { timeout: 90_000 },
  ).catch(async () => {
    await docker(["rm", "-f", devProjectName(slug)], { timeout: 30_000 }).catch(
      () => {},
    );
  });
  // Drop the staged clone token — startDev regenerates a fresh one on restart.
  await rm(cloneSecretPath(slug), { force: true }).catch(() => {});
}

/**
 * Fully tear down a project's dev container on PROJECT DELETE: stop the stack,
 * remove the stack file + the deps volume, and WIPE the workspace dir (the
 * project is gone). The gateway itself is a platform singleton and is NOT torn
 * down here (ADR-0002) — its per-project users are removed separately.
 */
export async function teardownDev(slug: string): Promise<void> {
  await stopDev(slug).catch(() => {});
  await docker(["volume", "rm", "-f", depsVolume(slug)], {
    timeout: 30_000,
  }).catch(() => {});
  await rm(devStackFile(slug), { force: true }).catch(() => {});
  await rm(cloneSecretPath(slug), { force: true }).catch(() => {});
  await rm(workspaceDir(slug), { recursive: true, force: true }).catch(() => {});
}

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
function tunnelLaunchScript(slug: string): string {
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
function parseTunnelLog(log: string): {
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

/** Read the current tunnel log + pid state from the container. */
export async function getVscodeTunnel(slug: string): Promise<VscodeTunnelInfo> {
  const name = devProjectName(slug);
  const { stdout } = await docker(
    [
      "exec",
      name,
      "/bin/sh",
      "-c",
      `cat ${TUNNEL_LOG} 2>/dev/null; ` +
        `if [ -f ${TUNNEL_PID} ] && kill -0 "$(cat ${TUNNEL_PID} 2>/dev/null)" 2>/dev/null; then echo __DEPLO_RUNNING__; fi`,
    ],
    { timeout: 15_000, noThrow: true },
  ).catch(() => ({ stdout: "" }) as { stdout: string });
  const running = stdout.includes("__DEPLO_RUNNING__");
  const log = stdout.replace("__DEPLO_RUNNING__", "").trim();
  return { running, log: log.slice(-2000), ...parseTunnelLog(log) };
}

/**
 * Start the VS Code tunnel in a project's dev container (idempotent), then poll
 * briefly for the device-login link so the UI can show it immediately.
 */
export async function startVscodeTunnel(slug: string): Promise<VscodeTunnelInfo> {
  const name = devProjectName(slug);
  // Launch as the dev user (UID 1000) so the tunnel owns its files.
  await docker(
    ["exec", "-u", "1000", "-w", "/workspace", name, "/bin/sh", "-lc", tunnelLaunchScript(slug)],
    { timeout: 120_000, noThrow: true },
  );
  // Poll the log up to ~24s for the device-code line OR a completed connection
  // (the CLI download can take a moment). Return as soon as there's something to
  // show the user — the login link is what they act on first.
  for (let i = 0; i < 12; i++) {
    const info = await getVscodeTunnel(slug);
    if (info.loginUrl || info.connected) return info;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return getVscodeTunnel(slug);
}

/**
 * Stop the VS Code tunnel (kills the process; the CLI download AND the auth
 * token are kept). `tunnel kill` only stops the running tunnel — it does NOT log
 * out — and we pass the same --cli-data-dir so it acts on the same CLI state and
 * never falls back to a stray default dir. So Close-then-Open re-uses the
 * existing GitHub login.
 */
export async function stopVscodeTunnel(slug: string): Promise<void> {
  const name = devProjectName(slug);
  await docker(
    [
      "exec",
      name,
      "/bin/sh",
      "-c",
      `[ -f ${TUNNEL_PID} ] && kill "$(cat ${TUNNEL_PID})" 2>/dev/null; rm -f ${TUNNEL_PID}; ${CODE_CLI} tunnel --cli-data-dir ${CLI_DATA_DIR} kill 2>/dev/null || true`,
    ],
    { timeout: 20_000, noThrow: true },
  ).catch(() => {});
}

/**
 * The SSH-gateway projection — PURE.
 *
 * The store's `DevSshUser[]` is the sole source of truth (ADR-0002); the running
 * gateway container is a disposable projection of it. This module computes that
 * projection as DATA: the exact `docker exec` steps that provision/deprovision a
 * user, the rendered sshd_config / wrapper / socket-filter / compose, and the
 * exec-target guard. No `server-only`, no docker, no store, no crypto — inputs
 * in, plans and config strings out — so the security-critical bits (shell
 * quoting, the control-plane guard, the credential decision) are testable
 * without a container.
 *
 * The impure DRIVER (ssh-gateway.ts) decrypts the password just-in-time, then
 * runs these steps via `docker exec`. The secret never enters this module's
 * inputs as ciphertext: a provision plan takes the ALREADY-DECRYPTED password
 * (or null), so cleartext lives only in the driver's call frame.
 */

/** A single `docker exec -i <gateway> <argv...>` the driver runs, optionally
 * piping `input` to the command's stdin (used for chpasswd / file writes). */
export interface GatewayStep {
  argv: string[];
  input?: string;
}

/** The resolved exec target for a user's project: its slug + dev container. */
export interface GatewayTarget {
  slug: string;
  container: string;
}

/** Just the fields the projection reads from a DevSshUser. A stored `DevSshUser`
 * satisfies this structurally; `password` is the DECRYPTED value (or null). */
export interface ProvisionInput {
  username: string;
  /** Decrypted password, or null/empty for a key-only user. */
  password: string | null;
  /** SSH public key line, or null/empty for a password-only user. */
  publicKey: string | null;
}

/** The Linux group every dev SSH user belongs to (the ForceCommand matches it). */
export const DEV_GROUP = "devusers";
/** The in-container exec target UID — always 1000, never a name, never the
 * client (CONTEXT.md: devuser = UID 1000, end-to-end). */
export const EXEC_UID = "1000";
/** The ForceCommand wrapper path inside the gateway. */
export const WRAPPER_PATH = "/usr/local/bin/deplo-dev-shell";

/** Quote a value for safe single-quoted interpolation into a `sh -c` string. */
export function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether `container` is a legitimate `docker exec` target for the ForceCommand
 * wrapper: it must look like a dev container (`deplo-dev-*`) and must NOT be a
 * control-plane container (the control plane or the gateway itself — execing
 * there would be a re-escalation path, ADR-0003). This mirrors the guard baked
 * into the wrapper shell so the invariant is documented and testable in TS.
 */
export function isValidExecTarget(container: string): boolean {
  if (!container.startsWith("deplo-dev-")) return false;
  if (container === "deplo" || container === "deplo-ssh-gateway") return false;
  return true;
}

/** The root-owned map file body the wrapper sources (SLUG + DEV_CONTAINER only —
 * not secret; the exec UID is hardcoded in the wrapper, never read from here). */
export function mapFileBody(target: GatewayTarget): string {
  return (
    `SLUG=${shellQuote(target.slug)}\n` +
    `DEV_CONTAINER=${shellQuote(target.container)}\n`
  );
}

/**
 * The ordered steps that provision one user inside the running gateway (no sshd
 * reload — sshd reads accounts/keys/maps per-connection):
 *  1. Account: shell is the wrapper, member of the dev group. Idempotent.
 *  2. Credential: chpasswd from stdin for a password user; `usermod -p '*'` for
 *     a key-only user (DISABLE password without LOCKING the account — a locked
 *     account refuses pubkey auth too under `UsePAM no`).
 *  3. authorized_keys (key users) — world-readable 0644, root-owned, `restrict`.
 *     Password-only users get the key dir removed.
 *  4. Map file (atomic tmp+rename), root-owned 0644.
 */
export function provisionSteps(
  user: ProvisionInput,
  target: GatewayTarget,
): GatewayStep[] {
  const steps: GatewayStep[] = [];
  const u = shellQuote(user.username);

  // 1. Account (idempotent).
  steps.push({
    argv: [
      "sh",
      "-c",
      `id ${u} >/dev/null 2>&1 || ` +
        `adduser -D -G ${DEV_GROUP} -s ${WRAPPER_PATH} ${u}`,
    ],
  });

  // 2. Credentials. Cleartext password (if any) goes over STDIN, never argv/env
  // that `docker inspect` could surface.
  if (user.password) {
    steps.push({
      argv: ["sh", "-c", "chpasswd"],
      input: `${user.username}:${user.password}\n`,
    });
  } else {
    // `usermod -p '*'` forbids password auth while leaving pubkey auth working;
    // `passwd -l` would prepend '!' → a locked account that refuses every method.
    steps.push({ argv: ["usermod", "-p", "*", user.username] });
  }

  // 3. authorized_keys (key users only).
  const keyDir = `/data/ssh-gateway/keys/${user.username}`;
  if (user.publicKey && user.publicKey.trim()) {
    const line = `restrict,pty ${user.publicKey.trim()}\n`;
    steps.push({
      argv: ["sh", "-c", `mkdir -p ${shellQuote(keyDir)} && chmod 755 ${shellQuote(keyDir)}`],
    });
    steps.push({
      argv: [
        "sh",
        "-c",
        `cat > ${shellQuote(`${keyDir}/authorized_keys`)} && chmod 644 ${shellQuote(`${keyDir}/authorized_keys`)}`,
      ],
      input: line,
    });
  } else {
    steps.push({ argv: ["sh", "-c", `rm -rf ${shellQuote(keyDir)}`] });
  }

  // 4. Map file (atomic tmp+rename), root-owned 0644.
  const mapPath = `/data/ssh-gateway/map/${user.username}`;
  steps.push({
    argv: [
      "sh",
      "-c",
      `umask 022 && cat > ${shellQuote(`${mapPath}.tmp`)} && ` +
        `chown root:root ${shellQuote(`${mapPath}.tmp`)} && ` +
        `chmod 644 ${shellQuote(`${mapPath}.tmp`)} && ` +
        `mv ${shellQuote(`${mapPath}.tmp`)} ${shellQuote(mapPath)}`,
    ],
    input: mapFileBody(target),
  });

  return steps;
}

/**
 * The steps that remove one user: hard-evict any live session, drop the account,
 * remove the key + map files.
 */
export function deprovisionSteps(username: string): GatewayStep[] {
  const u = shellQuote(username);
  return [
    { argv: ["sh", "-c", `pkill -u ${u} 2>/dev/null || true`] },
    { argv: ["sh", "-c", `deluser ${u} 2>/dev/null || true`] },
    {
      argv: [
        "sh",
        "-c",
        `rm -rf /data/ssh-gateway/keys/${u} /data/ssh-gateway/map/${u}`,
      ],
    },
  ];
}

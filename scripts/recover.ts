/**
 * Break-glass recovery, run on the host that runs Deplo — `bun run recover`.
 *
 * WHY THIS EXISTS. The instance owner (lib/data/instance-owner.ts) is immutable
 * from inside the product: no other admin can demote, suspend or password-reset
 * them, which is the whole point — it closes the takeover where one admin you
 * promoted seizes the instance. But it also means the owner locking themselves
 * out (forgotten password, mistyped email, an account that was suspended before
 * the crown existed) has no in-product way back, and Deplo deliberately ships no
 * self-service password reset (no SMTP to depend on, no reset-token surface).
 *
 * So the escape hatch is where an escape hatch belongs: on the box, behind SSH,
 * available only to whoever already controls the machine Deplo runs on — the
 * same trust level that could read `DEPLO_SECRET` or the database directly. This
 * is Coolify's `root:reset-password` shape, and it is the ONE place in the
 * product where dropping to a shell is the intended path rather than a failure
 * of the happy path (AGENTS.md "Core mission"): every user-facing flow stays
 * shell-free, and this only exists for the case where there is no user-facing
 * flow left to use.
 *
 * It talks to Postgres through the normal data layer's client, so it inherits
 * `DEPLO_DATABASE_URL` and writes hashes with the same `hashPassword` the app
 * uses — there is no second password format to keep in sync.
 */

import { and, asc, eq } from "drizzle-orm";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { getDb } from "../lib/db/client";
import {
  instanceSettings,
  servers as serversTable,
  users as usersTable,
} from "../lib/db/schema/control-plane";
import {
  account as accountTable,
  session as sessionTable,
} from "../lib/db/schema/auth";
import { hashPassword } from "../lib/crypto";

const USAGE = `
deplo recover — break-glass account recovery (run on the Deplo host)

  bun run recover list
      Every account: username, email, and whether it is admin / owner / suspended.

  bun run recover password <username> [newPassword]
      Set an account's password. Omit newPassword to be prompted (hidden input);
      pass "-" to have a strong one generated and printed.

  bun run recover owner <username>
      Give this account the instance-owner crown, and with it instance admin +
      an un-suspended state. Use when the owner has been locked out, or when an
      instance upgraded from before ownership existed has no owner at all.

  bun run recover admin <username>
      Grant instance admin without touching ownership.

  bun run recover unsuspend <username>
      Lift a suspension.

  bun run recover server-address <server> <address> [agentPort]
      Rewrite where Deplo dials a server's agent (<server> is its name or id).
      Direct write, no reachability check - for undoing a mistyped address when
      the panel itself can no longer fix it.
`.trim();

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/** Read a line with the terminal echo off, so a password never lands on screen. */
async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY)
    fail(
      "No terminal to prompt on. Pass the password as an argument, or use '-' to generate one.",
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // `output.write` is what readline uses to echo; muting it hides the typing
  // while leaving the prompt itself visible (written before the mute flips on).
  const out = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput: (s: string) => void };
  process.stdout.write(label);
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted) out.output.write(s);
  };
  muted = true;
  const answer = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  process.stdout.write("\n");
  return answer;
}

/** Resolve a username (or email) to a row, failing loudly rather than guessing. */
async function findUser(handle: string) {
  const needle = handle.replace(/^@/, "").toLowerCase();
  const rows = await getDb()
    .select({
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
      isInstanceAdmin: usersTable.isInstanceAdmin,
      suspended: usersTable.suspended,
    })
    .from(usersTable);
  const user = rows.find(
    (u) => u.username.toLowerCase() === needle || u.email.toLowerCase() === needle,
  );
  if (!user)
    fail(
      `No account matches "${handle}". Run \`bun run recover list\` to see them.`,
    );
  return user;
}

async function ownerUserId(): Promise<string | null> {
  const rows = await getDb()
    .select({ ownerUserId: instanceSettings.ownerUserId })
    .from(instanceSettings)
    .limit(1);
  return rows[0]?.ownerUserId ?? null;
}

async function cmdList() {
  const owner = await ownerUserId();
  const rows = await getDb()
    .select({
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
      isInstanceAdmin: usersTable.isInstanceAdmin,
      suspended: usersTable.suspended,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(asc(usersTable.createdAt));
  if (rows.length === 0) fail("This instance has no accounts yet.");
  console.log();
  for (const u of rows) {
    const tags = [
      u.id === owner ? "OWNER" : u.isInstanceAdmin ? "admin" : null,
      u.suspended ? "SUSPENDED" : null,
    ].filter(Boolean);
    console.log(
      `  @${u.username.padEnd(20)} ${u.email.padEnd(32)} ${tags.join(" ")}`,
    );
  }
  if (owner === null)
    console.log(
      "\n  This instance has NO owner. `bun run recover owner <username>` claims it.",
    );
  console.log();
}

async function cmdPassword(handle: string, given: string | undefined) {
  const user = await findUser(handle);

  let password: string;
  if (given === "-") {
    // url-safe-ish and long enough that nobody is tempted to keep it.
    password = randomBytes(18).toString("base64url");
  } else if (given) {
    password = given;
  } else {
    password = await promptHidden(`  New password for @${user.username}: `);
    const again = await promptHidden("  Repeat it: ");
    if (password !== again) fail("Those passwords don't match.");
  }
  if (password.length < 8) fail("Choose a password of at least 8 characters.");

  // The credential lives on the Better Auth `account` row since migration 0055.
  // Written with plain drizzle rather than through lib/auth so this script stays
  // free of `next/headers` (it runs from a terminal, not a request).
  const updated = await getDb()
    .update(accountTable)
    .set({ password: await hashPassword(password), updatedAt: new Date() })
    .where(
      and(
        eq(accountTable.userId, user.id),
        eq(accountTable.providerId, "credential"),
      ),
    )
    .returning({ id: accountTable.id });
  if (updated.length === 0)
    await getDb().insert(accountTable).values({
      id: `bacc_${randomBytes(8).toString("hex")}`,
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: await hashPassword(password),
    });
  // Kill every live session: whoever locked this account out must not keep a cookie.
  await getDb().delete(sessionTable).where(eq(sessionTable.userId, user.id));

  console.log(`\n  Password updated for @${user.username}.`);
  if (given === "-") console.log(`  New password: ${password}`);
  if (user.suspended)
    console.log(
      `  NOTE: @${user.username} is SUSPENDED and still can't sign in — run \`bun run recover unsuspend ${user.username}\`.`,
    );
  console.log();
}

async function cmdOwner(handle: string) {
  const user = await findUser(handle);
  const current = await ownerUserId();
  if (current === user.id)
    fail(`@${user.username} already owns this instance.`);

  const now = new Date().toISOString();
  await getDb().transaction(async (tx) => {
    // The crown implies both of these, so grant them rather than leave the
    // instance in a state the app's invariants don't describe.
    await tx
      .update(usersTable)
      .set({ isInstanceAdmin: true, suspended: false })
      .where(eq(usersTable.id, user.id));
    await tx
      .insert(instanceSettings)
      .values({ id: "default", ownerUserId: user.id, updatedAt: now })
      .onConflictDoUpdate({
        target: instanceSettings.id,
        set: { ownerUserId: user.id, updatedAt: now },
      });
  });

  console.log(
    `\n  @${user.username} now owns this instance (instance admin, not suspended).`,
  );
  console.log(
    "  The previous owner keeps their admin flag — demote them from Settings → Users if that isn't what you want.\n",
  );
}

async function cmdAdmin(handle: string) {
  const user = await findUser(handle);
  await getDb()
    .update(usersTable)
    .set({ isInstanceAdmin: true })
    .where(eq(usersTable.id, user.id));
  console.log(`\n  @${user.username} is now an instance admin.\n`);
}

async function cmdUnsuspend(handle: string) {
  const user = await findUser(handle);
  await getDb()
    .update(usersTable)
    .set({ suspended: false })
    .where(eq(usersTable.id, user.id));
  console.log(`\n  @${user.username} can sign in again.\n`);
}

/**
 * The break-glass half of updateServerAddress (lib/data/servers.ts): same two
 * columns, none of the checks. The product path verifies the agent answers at
 * the new address before saving - which is exactly what makes it useless once a
 * typo'd address is already stored and the panel can no longer reach the host
 * to fix itself (the Deplo-host row most of all). Whoever can run this already
 * owns the box, like every other command here.
 */
async function cmdServerAddress(handle: string, address?: string, portArg?: string) {
  if (!address) fail(`\`server-address\` needs the new address.\n\n${USAGE}`);
  const rows = await getDb()
    .select({
      id: serversTable.id,
      name: serversTable.name,
      host: serversTable.host,
      ip: serversTable.ip,
      agentPort: serversTable.agentPort,
    })
    .from(serversTable);
  const needle = handle.toLowerCase();
  const server = rows.find(
    (s) => s.id === handle || s.name.toLowerCase() === needle,
  );
  if (!server)
    fail(
      `No server matches "${handle}". Known: ${rows.map((s) => `${s.name} (${s.id})`).join(", ") || "none"}.`,
    );
  const port = portArg ? Number(portArg) : null;
  if (portArg && (!Number.isInteger(port) || port! < 1 || port! > 65535))
    fail(`"${portArg}" is not a valid port.`);
  await getDb()
    .update(serversTable)
    .set({
      host: address,
      ip: address,
      ...(port && server.agentPort != null ? { agentPort: port } : {}),
    })
    .where(eq(serversTable.id, server.id));
  console.log(
    `\n  ${server.name}: ${server.ip} -> ${address}` +
      (port && server.agentPort != null ? ` (agent port ${server.agentPort} -> ${port})` : "") +
      `\n`,
  );
}

async function main() {
  const [command, handle, extra, extra2] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help")
    return void console.log(`\n${USAGE}\n`);

  if (command === "list") return cmdList();
  if (!handle)
    fail(
      `\`${command}\` needs a ${command === "server-address" ? "server" : "username"}.\n\n${USAGE}`,
    );
  if (command === "server-address") return cmdServerAddress(handle, extra, extra2);
  if (command === "password") return cmdPassword(handle, extra);
  if (command === "owner") return cmdOwner(handle);
  if (command === "admin") return cmdAdmin(handle);
  if (command === "unsuspend") return cmdUnsuspend(handle);
  fail(`Unknown command "${command}".\n\n${USAGE}`);
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    fail(e instanceof Error ? e.message : String(e));
  });

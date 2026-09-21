import { and, asc, eq } from "drizzle-orm";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { getDb } from "../lib/db/client";
import { users as usersTable } from "../lib/db/schema/control-plane/identity";
import { instanceSettings } from "../lib/db/schema/control-plane/instance";
import { servers as serversTable } from "../lib/db/schema/control-plane/servers";
import {
  account as accountTable,
  session as sessionTable,
} from "../lib/db/schema/auth";
import { hashPassword } from "../lib/crypto";
import { panelRoute, withPanelRoute } from "../lib/deploy/traefik-stack";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
  isIpv4,
  wildcardEmbeddedIp,
  panelFallbackHost,
} from "../lib/deploy/domains";

const CMD = process.env.DEPLO_RECOVER_CMD || "bun run recover";

const USAGE = `
Deplo recover - break-glass account recovery (run on the Deplo host)

  ${CMD} list
      Every account: username, email, and whether it is admin / owner / suspended.

  ${CMD} password <username> [newPassword]
      Set an account's password. Omit newPassword to be prompted (hidden input);
      pass "-" to have a strong one generated and printed.

  ${CMD} owner <username>
      Give this account the instance-owner crown, and with it instance admin +
      an un-suspended state. Use when the owner has been locked out, or when an
      instance upgraded from before ownership existed has no owner at all.

  ${CMD} admin <username>
      Grant instance admin without touching ownership.

  ${CMD} unsuspend <username>
      Lift a suspension.

  ${CMD} panel-address <address|->
      Move the panel's own route onto <address> (a domain, optionally with
      http:// or https://), on the server that runs Deplo. Pass "-" for the
      generated deplo-<hex>.deplo.site address, which also turns the backup address
      back on. The way back in when the panel's domain is what broke.

  ${CMD} server-address <server> <address> [agentPort]
      Rewrite where Deplo dials a server's agent (<server> is its name or id).
      Direct write, no reachability check - for undoing a mistyped address when
      the panel itself can no longer fix it.
`.trim();

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

export function hiddenEcho(label: string, redraw: string): string {
  return redraw.startsWith(label) ? label : "";
}

async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY)
    fail(
      "No terminal to prompt on. Pass the password as an argument, or use '-' to generate one.",
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const out = rl as unknown as {
    output: NodeJS.WriteStream;
    _writeToOutput: (s: string) => void;
  };
  const answer = await new Promise<string>((resolve) => {
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      process.exit(130);
    });
    rl.on("close", () => resolve(""));
    rl.question(label, resolve);
    out._writeToOutput = (s: string) => {
      const echo = hiddenEcho(label, s);
      if (echo) out.output.write(echo);
    };
  });
  rl.close();
  process.stdout.write("\n");
  return answer;
}

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
    (u) =>
      u.username.toLowerCase() === needle || u.email.toLowerCase() === needle,
  );
  if (!user)
    fail(`No account matches "${handle}". Run \`${CMD} list\` to see them.`);
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
      `\n  This instance has NO owner. \`${CMD} owner <username>\` claims it.`,
    );
  console.log();
}

async function cmdPassword(handle: string, given: string | undefined) {
  const user = await findUser(handle);

  let password: string;
  if (given === "-") {
    password = randomBytes(18).toString("base64url");
  } else if (given) {
    password = given;
  } else {
    password = await promptHidden(`  New password for @${user.username}: `);
    const again = await promptHidden("  Repeat it: ");
    if (password !== again) fail("Those passwords don't match.");
  }
  if (password.length < 8) fail("Choose a password of at least 8 characters.");

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
    await getDb()
      .insert(accountTable)
      .values({
        id: `bacc_${randomBytes(8).toString("hex")}`,
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: await hashPassword(password),
      });
  await getDb().delete(sessionTable).where(eq(sessionTable.userId, user.id));

  console.log(`\n  Password updated for @${user.username}.`);
  if (given === "-") console.log(`  New password: ${password}`);
  if (user.suspended)
    console.log(
      `  NOTE: @${user.username} is SUSPENDED and still can't sign in - run \`${CMD} unsuspend ${user.username}\`.`,
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
    "  The previous owner keeps their admin flag - demote them from Settings → Users if that isn't what you want.\n",
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

async function cmdServerAddress(
  handle: string,
  address?: string,
  portArg?: string,
) {
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
      (port && server.agentPort != null
        ? ` (agent port ${server.agentPort} -> ${port})`
        : "") +
      `\n`,
  );
}

async function cmdPanelAddress(arg: string) {
  const servers = await getDb()
    .select({
      id: serversTable.id,
      name: serversTable.name,
      host: serversTable.host,
      ip: serversTable.ip,
    })
    .from(serversTable);
  const self = deploHostSelfAddresses();
  const server =
    servers.find((s) => isDeploHostServer(s, self)) ??
    (servers.length === 1 ? servers[0] : null);
  if (!server)
    fail(
      `Cannot tell which server runs Deplo. Set DEPLO_SERVER_IP to its address and try again. Known: ${servers.map((s) => s.name).join(", ") || "none"}.`,
    );

  const { fetchHostInfo, applyTraefikConfig } =
    await import("../lib/infra/agent-client/host-ops");
  const yaml = (await fetchHostInfo(server.id)).traefikComposeYaml;
  const current = yaml ? panelRoute(yaml) : null;
  if (!current)
    fail(
      `${server.name} does not publish the panel through a route Deplo manages, so there is nothing here to move.`,
    );

  const generated = arg === "-";
  let domain: string;
  let https = current.https;
  if (generated) {
    domain = panelFallbackHost(isIpv4(server.ip ?? "") ? server.ip : undefined);
    if (!wildcardEmbeddedIp(domain))
      fail(
        `Deplo cannot work out the generated address on ${server.name}. Pass a domain instead.`,
      );
  } else {
    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(arg) ? arg : `https://${arg}`);
    } catch {
      fail(`"${arg}" is not an address. Use a domain like deplo.example.com`);
    }
    domain = parsed.hostname;
    https = parsed.protocol === "https:";
  }

  const res = await applyTraefikConfig(server.id, {
    composeYaml: withPanelRoute(yaml, { ...current, domain, https }),
  });
  if (!res.ok)
    fail(res.error || `The proxy on ${server.name} refused the new address`);

  const url = `${https ? "https" : "http"}://${domain}`;
  const now = new Date().toISOString();
  const set = {
    panelUrl: url,
    updatedAt: now,
    ...(generated ? { panelFallbackDisabled: false } : {}),
  };
  await getDb()
    .insert(instanceSettings)
    .values({ id: "default", ...set })
    .onConflictDoUpdate({ target: instanceSettings.id, set });

  console.log(
    `\n  panel: ${current.domain} -> ${domain} (${https ? "https" : "http"})`,
  );
  if (generated) console.log("  backup address turned back on");
  console.log(
    "  Restart Deplo so install commands and links carry the new address.\n",
  );
}

async function main() {
  const [command, handle, extra, extra2] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help")
    return void console.log(`\n${USAGE}\n`);

  if (command === "list") return cmdList();
  if (command === "panel-address") {
    if (!handle) fail(`\`panel-address\` needs an address.\n\n${USAGE}`);
    return cmdPanelAddress(handle);
  }
  if (!handle)
    fail(
      `\`${command}\` needs a ${command === "server-address" ? "server" : "username"}.\n\n${USAGE}`,
    );
  if (command === "server-address")
    return cmdServerAddress(handle, extra, extra2);
  if (command === "password") return cmdPassword(handle, extra);
  if (command === "owner") return cmdOwner(handle);
  if (command === "admin") return cmdAdmin(handle);
  if (command === "unsuspend") return cmdUnsuspend(handle);
  fail(`Unknown command "${command}".\n\n${USAGE}`);
}

if (require.main === module)
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      fail(e instanceof Error ? e.message : String(e));
    });

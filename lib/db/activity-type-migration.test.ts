import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

/**
 * Migration-parity test for 0128, which splits `member` into four finer types by
 * reading the messages already on disk. The half that matters is the second one:
 * a pattern that is not anchored files a people event under the wrong heading.
 */

const MIG_DIR = path.join(process.cwd(), "lib", "db", "migrations");
const SPLIT = "0128_split_member_activity_type.sql";

/** One row per real message template, and where 0128 must file it. */
const CASES: [string, string][] = [
  // security
  ["Created the CI API token", "security"],
  ["Updated the CI API token", "security"],
  ["Revoked the CI API token", "security"],
  ["Added the YubiKey passkey", "security"],
  ["Removed the YubiKey passkey", "security"],
  ["Removed @ada's passkey", "security"],
  ["Removed @ada's 2 passkeys", "security"],
  ["Reset two-factor authentication for @ada", "security"],
  ["Two-factor sign-in is now required for this team", "security"],
  // mcp - same call site as the API-token revoke, told apart by the message
  ["Revoked Claude's MCP access", "mcp"],
  // server
  ["Connected server eu-main-1", "server"],
  ["Reissued install command for server eu-main-1", "server"],
  ["Removed server eu-main-1", "server"],
  ["2 pending teardowns on eu-main-1 were dropped with the server.", "server"],
  ["Uninstalled the agent from eu-main-1 (it answered)", "server"],
  ["Changed server eu-main-1 address to 10.0.0.1:9443", "server"],
  ["Updated agent on eu-main-1 to v1.31.0", "server"],
  ["Made server eu-main-1 available to all teams", "server"],
  ["Set server eu-main-1 access to 2 teams", "server"],
  ["Set deploy concurrency for server eu-main-1 to 4", "server"],
  ["Set server eu-main-1 to build only", "server"],
  ["Set server eu-main-1 to hold backups only", "server"],
  ["Set server eu-main-1 to run apps again", "server"],
  ["Set the timezone on eu-main-1 to Europe/Rome", "server"],
  ["Restarted 3 workloads on eu-main-1", "server"],
  ["Restarted Traefik on eu-main-1", "server"],
  ["Restarted the Deplo panel", "server"],
  ["Published the Traefik panel for eu-main-1 on proxy.acme.com", "server"],
  ["Turned off the Traefik panel for eu-main-1", "server"],
  ["Installed a TLS certificate for acme.com on eu-main-1", "server"],
  ["Removed the TLS certificate for acme.com from eu-main-1", "server"],
  [
    "Could not remove Deplo's agent from eu-main-1 after 3 tries: refused",
    "server",
  ],
  [
    "Set the certificate account email to admin@acme.com on 2 servers",
    "server",
  ],
  // integration
  ["Connected GitLab as ada", "integration"],
  ["Updated the GitLab git connection", "integration"],
  ["Disconnected the GitLab git connection", "integration"],
  ["Connected GitHub App deplo-ci", "integration"],
  ["Installed GitHub App on acme", "integration"],
  ["Removed GitHub App deplo-ci", "integration"],
  ["Added registry ghcr", "integration"],
  ["Removed registry ghcr", "integration"],
  // instance
  ["Set the maximum log range to 30 days", "instance"],
  ["Turned on Gravatar profile pictures", "instance"],
  ["Turned off Gravatar profile pictures", "instance"],
  ["Set the Deplo panel address to https://deplo.acme.com", "instance"],
  ["Cleared the Deplo panel address", "instance"],
  ["Moved the panel to https://deplo.acme.com", "instance"],
  ["3 activity entries could not be recorded on this instance", "instance"],
  // …and everything that is still about people STAYS `member`. These are the
  // ones an unanchored LIKE would carry off.
  ["Created team Acme", "member"],
  ["Added @ada to the team", "member"],
  ["Removed @ada from the team", "member"],
  ["Set @ada's access to Deploy", "member"],
  ["Created the API token role", "member"],
  ["Updated the Servers role", "member"],
  ["Reset the Owner role", "member"],
  ["Deleted the registry role", "member"],
  ["Transferred ownership of this team to @ada", "member"],
  ["Transferred instance ownership to @ada", "member"],
  ["Deleted the account @ada", "member"],
  ["Changed the team picture", "member"],
  ["Updated user @ada (password reset)", "member"],
];

let pg: PGlite;

async function applyFile(file: string): Promise<void> {
  const sql = readFileSync(path.join(MIG_DIR, file), "utf8");
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const s = chunk.trim();
    if (s) await pg.exec(s);
  }
}

before(async () => {
  pg = new PGlite();
  const files = readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    if (f === SPLIT) break;
    await applyFile(f);
  }
  await pg.exec(`insert into teams (id, name, slug, plan, created_at)
                 values ('team_a', 'Acme', 'acme', 'free', now());`);
  for (const [i, [message]] of CASES.entries())
    await pg.query(
      `insert into activities (id, team_id, type, message, actor, created_at)
       values ($1, 'team_a', 'member', $2, 'owner', now())`,
      [`act_${i}`, message],
    );
  await applyFile(SPLIT);
});

after(async () => {
  await pg.close();
});

test("0128: every stored `member` message lands on the right type", async () => {
  const rows = (
    await pg.query<{ message: string; type: string }>(
      "select message, type from activities",
    )
  ).rows;
  const got = new Map(rows.map((r) => [r.message, r.type]));
  const wrong = CASES.filter(
    ([message, want]) => got.get(message) !== want,
  ).map(
    ([message, want]) => `${message} -> ${got.get(message)} (want ${want})`,
  );
  assert.deepEqual(wrong, [], "misfiled rows");
});

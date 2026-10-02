import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

import { makeTestDb, truncateAll, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import {
  deriveKey,
  encryptSecret,
  sha256Hex,
  tryDecryptSecret,
} from "../../crypto";
import type { DumpFrame } from "../../deplo-move/protocol";
import { schemaTag } from "../../deplo-move/schema-tag";
import { MOVE_TABLES, copyOrder, copyPolicy } from "../../deplo-move/tables";
import { seedIdentity, USER_1, TEAM_A } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedPreview,
} from "../app-graph-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedDestination,
  seedRun,
} from "../backup-test-helpers";
import { dumpInstance } from "./dump";
import { isSealed, openValue } from "./rekey";
import { restoreInstance } from "./restore";

type Row = Record<string, unknown>;

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-09-01T00:00:00.000Z";
const LOST_KEY = "a-secret-nobody-has-anymore-0000";
const OLD_KEY = "old-deplo-secret-1111111111111111";
const NEW_KEY = "new-deplo-secret-2222222222222222";
const SELF_IP = "192.0.2.200";
const ENV = ["DEPLO_SECRET", "DEPLO_SERVER_IP", "DEPLO_PUBLIC_URL"] as const;

let db: TestDb;
let pg: PGlite;
const savedEnv: Partial<Record<(typeof ENV)[number], string>> = {};

const q = (text: string, params: unknown[] = []) => pg.query(text, params);
const baKey = () => deriveKey("better-auth").toString("hex");

before(async () => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_SERVER_IP = SELF_IP;
  process.env.DEPLO_PUBLIC_URL = "https://new.deplo.test";
});

after(async () => {
  for (const k of ENV)
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await truncateAll(pg);
});

async function seedOldDeplo(): Promise<void> {
  process.env.DEPLO_SECRET = LOST_KEY;
  const lost = encryptSecret("sealed with a key nobody has");
  process.env.DEPLO_SECRET = OLD_KEY;

  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  for (const [id, name, ip] of [
    ["srv_old_host", "old-host", "198.51.100.10"],
    ["srv_worker", "worker", "198.51.100.11"],
  ])
    await seedServerRow(db, {
      id,
      name,
      ip,
      host: ip,
      agent: {
        port: 9443,
        certFingerprint: `sha256:${name}`,
        certPem: "-----BEGIN CERTIFICATE-----",
        version: "1.0.0",
      },
    });
  await q(
    `insert into server_teams (server_id, team_id) values ('srv_worker', 'team_a')`,
  );
  await q(
    `insert into team_roles (id, team_id, name, created_at) values ('role_dev', 'team_a', 'Developer', $1)`,
    [T0],
  );
  await q(
    `insert into team_role_capabilities (role_id, capability) values ('role_dev', 'deploy_apps')`,
  );
  await q(
    `update memberships set role_id = 'role_dev' where id = 'mem_user_2'`,
  );
  await q(
    `insert into projects (id, team_id, name, slug, created_at, updated_at) values ('prc_1', 'team_a', 'Shop', 'shop', $1, $1)`,
    [T0],
  );
  await q(
    `insert into environments (id, project_id, name, slug, kind, position, created_at, updated_at)
     values ('environ_1', 'prc_1', 'Production', 'production', 'production', 0, $1, $1)`,
    [T0],
  );
  // Children land in the table before their parents.
  await q(
    `insert into folders (id, team_id, name, created_at, updated_at)
     values ('fld_leaf', 'team_a', 'Leaf', $1, $1), ('fld_child', 'team_a', 'Child', $1, $1), ('fld_root', 'team_a', 'Root', $1, $1)`,
    [T0],
  );
  await q(`update folders set parent_id = 'fld_child' where id = 'fld_leaf'`);
  await q(`update folders set parent_id = 'fld_root' where id = 'fld_child'`);

  await seedApp(db, {
    id: "prj_web",
    serverId: "srv_worker",
    folderId: "fld_child",
    projectId: "prc_1",
    environmentId: "environ_1",
    createdByUserId: USER_1,
  });
  await q(`update apps set deploy_hook_token_enc = $1 where id = 'prj_web'`, [
    encryptSecret("hook-token"),
  ]);
  await seedDeployment(db, {
    id: "dep_1",
    appId: "prj_web",
    serverId: "srv_worker",
  });
  await seedDeployment(db, {
    id: "dep_2",
    appId: "prj_web",
    serverId: "srv_worker",
  });
  await seedPreview(db, { id: "pv_7", appId: "prj_web", prNumber: 7 });
  await seedDeployment(db, {
    id: "dep_3",
    appId: "prj_web",
    previewId: "pv_7",
    prNumber: 7,
  });
  await q(
    `update apps set latest_deployment_id = 'dep_2' where id = 'prj_web'`,
  );
  await q(
    `update app_previews set latest_deployment_id = 'dep_3' where id = 'pv_7'`,
  );
  await q(
    `insert into app_environments (app_id, environment_id, latest_deployment_id, created_at, updated_at)
     values ('prj_web', 'environ_1', 'dep_2', $1, $1)`,
    [T0],
  );
  for (const text of ["build", "push", "up"])
    await q(
      `insert into deployment_logs (deployment_id, ts, level, text) values ('dep_2', $1, 'info', $2)`,
      [T0, text],
    );
  for (const [id, key, value, type] of [
    [
      "env_db",
      "DATABASE_URL",
      encryptSecret("postgres://app:pw@db/app"),
      "secret",
    ],
    ["env_plain", "GREETING", encryptSecret("hello"), "plain"],
    ["env_lost", "OLD_TOKEN", lost, "secret"],
  ])
    await q(
      `insert into env_vars (id, app_id, key, value_enc, type, created_by_user_id, created_at, updated_at)
       values ($1, 'prj_web', $2, $3, $4, 'user_1', $5, $5)`,
      [id, key, value, type, T0],
    );
  await q(
    `insert into env_var_targets (env_var_id, target) values ('env_db', 'production')`,
  );
  await q(
    `insert into shared_env_vars (id, team_id, key, value_enc, type, created_at, updated_at)
     values ('shv_1', 'team_a', 'SENTRY_DSN', $1, 'secret', $2, $2)`,
    [encryptSecret("https://sentry.example/1"), T0],
  );

  await seedDatabase(db, { id: "db_main", serverId: "srv_worker" });
  await seedDestination(db, { id: "dst_s3" });
  await seedDestination(db, { id: "dst_plain", legacyPlaintext: true });
  await seedDestination(db, {
    id: "dst_disk",
    kind: "server",
    serverId: "srv_worker",
  });
  await seedBackup(db, {
    id: "bk_1",
    destinationId: "dst_s3",
    databaseId: "db_main",
  });
  for (const id of ["run_1", "run_2"])
    await seedRun(db, {
      id,
      backupId: "bk_1",
      destinationId: "dst_s3",
      databaseId: "db_main",
    });

  await q(
    `insert into session (id, user_id, token, expires_at) values ('ses_old', 'user_1', 'old-session', '2030-01-01 00:00:00')`,
  );
  await q(
    `insert into two_factor (id, user_id, secret, backup_codes, locked_until)
     values ('tf_1', 'user_1', $1, $2, '2026-03-04 05:06:07.891')`,
    [
      await symmetricEncrypt({ key: baKey(), data: "TOTP-SEED" }),
      await symmetricEncrypt({ key: baKey(), data: '["aaaaa-bbbbb"]' }),
    ],
  );
  await q(
    `insert into passkey (id, user_id, public_key, credential_id, counter, device_type, backed_up, created_at)
     values ('pk_1', 'user_1', 'pub', 'cred-1', 3, 'singleDevice', true, '2026-02-01 10:00:00')`,
  );
  await q(
    `insert into oauth_client (id, client_id, client_secret, redirect_uris, scopes, metadata, created_at)
     values ('oc_1', 'client-abc', $1, array['https://ai.example/cb'], array['mcp'], '{"software":"x"}', '2026-02-01 10:00:00')`,
    [await symmetricEncrypt({ key: baKey(), data: "client-secret" })],
  );
  await q(
    `insert into oauth_resource (id, identifier, name) values ('ores_1', 'https://old.deplo.test/api/mcp', 'MCP')`,
  );
  await q(
    `insert into oauth_client_resource (id, client_id, resource_id) values ('ocr_1', 'client-abc', 'https://old.deplo.test/api/mcp')`,
  );
  await q(
    `insert into oauth_refresh_token (id, token, client_id, session_id, user_id, scopes, rotation_replay_response)
     values ('ort_1', 'rt-hash', 'client-abc', 'ses_old', 'user_1', array['mcp'], $1)`,
    [await symmetricEncrypt({ key: baKey(), data: '{"replay":true}' })],
  );
  await q(
    `insert into oauth_access_token (id, token, client_id, session_id, user_id, refresh_id, scopes)
     values ('oat_1', 'at-hash', 'client-abc', 'ses_old', 'user_1', 'ort_1', array['mcp'])`,
  );
  await q(
    `insert into api_tokens (id, user_id, name, token_hash, prefix, oauth_client_id, created_at)
     values ('tok_1', 'user_1', 'CI', $1, 'deplo_ab', 'client-abc', $2)`,
    [sha256Hex("deplo_abc"), T0],
  );
  await q(
    `insert into api_token_capabilities (token_id, capability) values ('tok_1', 'deploy_apps')`,
  );

  await q(
    `insert into instance_settings (id, owner_user_id, panel_url, vapid_public_key, vapid_private_key_enc, log_max_days, usage_instance_id, welcome_seen_at, network_sweep_failed, agent_rollout_by, booted_version, updated_at)
     values ('default', 'user_1', 'https://old.deplo.test', 'vapid-pub', $1, 30, 'old-usage', $2, 2, 'user_1', '0.4.0', $2)`,
    [encryptSecret("vapid-private"), T0],
  );
  await q(
    `insert into monitoring_settings (id, save_metrics, updated_at) values ('default', false, $1)`,
    [T0],
  );
  await q(
    `insert into docker_cleanup_policy (id, enabled, schedule, min_age_hours, keep_images_per_app, created_at, updated_at)
     values ('default', true, '0 4 * * *', 24, 3, $1, $1)`,
    [T0],
  );
  await q(
    `insert into notification_channels (id, team_id, kind, name, secret_enc, secret2_enc, created_at)
     values ('nch_1', 'team_a', 'webhook', 'Ops', '', $1, $2)`,
    [encryptSecret("signing-key"), T0],
  );
  await q(
    `insert into registries (id, team_id, name, type, registry_url, username, password_enc, created_at)
     values ('reg_1', 'team_a', 'GHCR', 'ghcr', 'ghcr.io', 'bot', $1, $2)`,
    [encryptSecret("ghcr-token"), T0],
  );
  for (const m of ["one", "two", "three"])
    await q(
      `insert into activities (id, team_id, type, message, actor, created_at) values ($1, 'team_a', 'deploy', $2, 'user_1', $3)`,
      [`act_${m}`, m, T0],
    );
}

// A fresh install on the new machine: one person, one team, its own server.
async function becomeNewDeplo(
  hostId = "srv_new_host",
  fingerprint = "sha256:new-host",
): Promise<void> {
  await truncateAll(pg);
  process.env.DEPLO_SECRET = NEW_KEY;
  await seedIdentity(db, {
    teams: [{ id: "team_new", slug: "new" }],
    users: [{ id: "user_new", teamId: "team_new", role: "owner" }],
  });
  await seedServerRow(db, {
    id: hostId,
    name: "new-host",
    ip: SELF_IP,
    host: SELF_IP,
    agent: {
      port: 9443,
      certFingerprint: fingerprint,
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.0.0",
    },
  });
  await q(
    `insert into server_teams (server_id, team_id) values ($1, 'team_new')`,
    [hostId],
  );
  await q(
    `insert into session (id, user_id, token, expires_at) values ('ses_new', 'user_new', 'new-session', '2030-01-01 00:00:00')`,
  );
  await q(
    `insert into verification (id, identifier, value, expires_at) values ('ver_1', 'reset', 'x', '2030-01-01 00:00:00')`,
  );
  await q(
    `insert into instance_settings (id, owner_user_id, panel_url, usage_instance_id, booted_version, network_sweep_failed, agent_rollout_by, updated_at)
     values ('default', 'user_new', 'https://new.deplo.test', 'new-usage', '0.5.0', 0, 'user_new', $1)`,
    [T1],
  );
  await q(
    `insert into rate_limits (key, count, reset_at) values ('login:new', 1, $1)`,
    [T1],
  );
  await q(
    `insert into scheduler_lease (name, owner) values ('backups', 'new-process')`,
  );
  await q(
    `insert into deplo_moves (id, side, state, started_by, created_at, updated_at)
     values ('dmv_new', 'target', 'copying', 'Admin', $1, $1)`,
    [T1],
  );
  await q(
    `insert into activities (id, team_id, type, message, actor, created_at) values ('act_new', 'team_new', 'setup', 'Set up', 'user_new', $1)`,
    [T1],
  );
}

// Every table, re-keyed values opened under the key in force.
async function snapshotAll(): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  for (const [table, policy] of Object.entries(MOVE_TABLES)) {
    const res = await pg.query<{ j: string }>(
      `select row_to_json(t)::text as j from "${table}" t`,
    );
    const rekey = Object.entries(
      policy.kind === "copy" ? (policy.rekey ?? {}) : {},
    );
    const rows: Row[] = [];
    for (const { j } of res.rows) {
      const row = JSON.parse(j) as Row;
      for (const [c, key] of rekey) {
        const v = row[c];
        if (isSealed(v))
          row[c] = (await openValue(key, v)) ?? { unreadable: v };
      }
      rows.push(row);
    }
    out.set(table, sortRows(rows));
  }
  return out;
}

function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

async function* replay(lines: string[], pulled = { count: 0 }) {
  for (const line of lines) {
    pulled.count++;
    yield line;
  }
}

describe("Deplo move: dump and restore", () => {
  test("copies every table to the new Deplo, sealed under its own key", async () => {
    await seedOldDeplo();
    const old = await snapshotAll();
    const lines = await collect(dumpInstance());
    const frames = lines.map((l) => JSON.parse(l) as DumpFrame);
    assert.deepEqual(frames[0], {
      kind: "begin",
      protocol: 1,
      schema: schemaTag(),
      tables: copyOrder(),
    });
    assert.ok(
      !lines.some((l) => l.includes("old-session")),
      "sessions are never sent",
    );
    assert.ok(lines.some((l) => l.includes("postgres://app:pw@db/app")));

    await becomeNewDeplo();
    const mine = await snapshotAll();
    const progress: number[] = [];
    const res = await restoreInstance(replay(lines), {
      onRows: (n) => progress.push(n),
    });
    const now = await snapshotAll();

    const copied = copyOrder().reduce((n, t) => n + old.get(t)!.length, 0);
    assert.deepEqual(res, { rows: copied, unreadable: 1 });
    assert.equal(progress.at(-1), copied);
    assert.deepEqual(frames.at(-1), {
      kind: "end",
      rows: copied,
      unreadable: 1,
    });

    for (const table of copyOrder()) {
      const policy = copyPolicy(table);
      let want = old.get(table)!.map((r) => {
        const row = { ...r };
        for (const c of policy.nullOnCopy ?? []) row[c] = null;
        return row;
      });
      if (policy.keepTarget) {
        const kept = mine.get(table)![0];
        want = want.map((r) => {
          const row = { ...r };
          for (const c of policy.keepTarget ?? []) row[c] = kept[c];
          return row;
        });
      }
      if (table === "servers")
        want = [
          ...want,
          ...mine.get(table)!.filter((s) => s.id === "srv_new_host"),
        ];
      assert.deepEqual(now.get(table), sortRows(want), table);
    }
    for (const [table, policy] of Object.entries(MOVE_TABLES)) {
      if (policy.kind === "copy") continue;
      const want =
        policy.kind === "skip" && policy.clear ? [] : mine.get(table);
      assert.deepEqual(now.get(table), want, table);
    }

    const settings = now.get("instance_settings")![0];
    assert.equal(settings.panel_url, "https://new.deplo.test");
    assert.equal(settings.usage_instance_id, "new-usage");
    assert.equal(settings.booted_version, "0.5.0", "this install's version");
    assert.equal(settings.network_sweep_failed, 2, "the fleet's, from the old");
    assert.equal(settings.agent_rollout_by, USER_1);
    assert.equal(settings.owner_user_id, USER_1);
    assert.equal(settings.log_max_days, 30);
    assert.equal(settings.vapid_private_key_enc, "vapid-private");
    assert.deepEqual(
      now.get("env_vars")!.find((r) => r.id === "env_lost")!.value_enc,
      old.get("env_vars")!.find((r) => r.id === "env_lost")!.value_enc,
    );
    assert.equal(
      now.get("backup_destination")!.find((r) => r.id === "dst_plain")!
        .age_identity_enc,
      null,
    );
    assert.equal(now.get("notification_channels")![0].secret_enc, "");
    assert.equal(now.get("apps")![0].latest_deployment_id, "dep_2");
    assert.equal(
      now.get("folders")!.find((r) => r.id === "fld_leaf")!.parent_id,
      "fld_child",
    );
    assert.equal(now.get("oauth_access_token")![0].session_id, null);

    const raw = await q(`select value_enc from env_vars where id = 'env_db'`);
    const sealed = (raw.rows[0] as { value_enc: string }).value_enc;
    assert.deepEqual(tryDecryptSecret(sealed), {
      ok: true,
      value: "postgres://app:pw@db/app",
    });
    const tf = await q(`select secret from two_factor`);
    assert.equal(
      await symmetricDecrypt({
        key: baKey(),
        data: (tf.rows[0] as { secret: string }).secret,
      }),
      "TOTP-SEED",
    );
  });

  test("identity columns carry on after the highest value copied", async () => {
    await seedOldDeplo();
    const lines = await collect(dumpInstance());
    await becomeNewDeplo();
    await restoreInstance(replay(lines));
    const act = await q(
      `insert into activities (id, team_id, type, message, actor, created_at)
       values ('act_after', 'team_a', 'deploy', 'after', 'user_1', $1) returning seq`,
      [T1],
    );
    assert.equal(Number((act.rows[0] as { seq: number }).seq), 4);
    const log = await q(
      `insert into deployment_logs (deployment_id, ts, level, text) values ('dep_2', $1, 'info', 'later') returning id`,
      [T1],
    );
    const max = await q(
      `select max(id) as m from deployment_logs where text <> 'later'`,
    );
    assert.equal(
      Number((log.rows[0] as { id: number }).id),
      Number((max.rows[0] as { m: number }).m) + 1,
    );
  });

  test("a copy cut short changes nothing on the new Deplo", async () => {
    await seedOldDeplo();
    const lines = await collect(dumpInstance());
    await becomeNewDeplo();
    const mine = await snapshotAll();
    await assert.rejects(
      restoreInstance(replay(lines.slice(0, -1))),
      /stopped before it finished\. Nothing was changed here/,
    );
    await assert.rejects(
      restoreInstance(replay([...lines.slice(0, 3), '{"kind":"ro'])),
      /arrived damaged/,
    );
    assert.deepEqual(await snapshotAll(), mine);
  });

  test("a copy from another version is refused before anything is read past it", async () => {
    await seedOldDeplo();
    const lines = await collect(dumpInstance());
    await becomeNewDeplo();
    const mine = await snapshotAll();
    const begin = JSON.parse(lines[0]) as Extract<DumpFrame, { kind: "begin" }>;

    const older = [
      JSON.stringify({ ...begin, schema: "0001_init" }),
      ...lines.slice(1),
    ];
    const pulled = { count: 0 };
    await assert.rejects(
      restoreInstance(replay(older, pulled)),
      /Update the old Deplo first/,
    );
    assert.equal(pulled.count, 1);

    const reordered = [
      JSON.stringify({ ...begin, tables: [...begin.tables].reverse() }),
      ...lines.slice(1),
    ];
    await assert.rejects(
      restoreInstance(replay(reordered)),
      /different versions/,
    );
    assert.deepEqual(await snapshotAll(), mine);
  });

  test("refuses an old Deplo that already has this machine as a server", async () => {
    await seedOldDeplo();
    const lines = await collect(dumpInstance());
    for (const [id, fingerprint] of [
      ["srv_worker", "sha256:new-host"],
      ["srv_new_host", "sha256:worker"],
    ]) {
      await becomeNewDeplo(id, fingerprint);
      const mine = await snapshotAll();
      await assert.rejects(
        restoreInstance(replay(lines)),
        /The old Deplo has this machine as its server "worker"/,
      );
      assert.deepEqual(await snapshotAll(), mine);
    }
  });

  test("a reader that stops early ends the snapshot it was reading", async () => {
    await seedOldDeplo();
    for await (const line of dumpInstance()) {
      assert.equal((JSON.parse(line) as DumpFrame).kind, "begin");
      break;
    }
    await q(
      `insert into rate_limits (key, count, reset_at) values ('after', 1, $1)`,
      [T1],
    );
    const res = await q(`select count(*)::int as n from rate_limits`);
    assert.equal((res.rows[0] as { n: number }).n, 1);
  });
});

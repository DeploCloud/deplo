import "server-only";

import { eq, sql } from "drizzle-orm";

import { getDb, type DbTx } from "../../db/client";
import {
  serverTeams,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { MOVE_PROTOCOL, type DumpFrame } from "../../deplo-move/protocol";
import { schemaTag } from "../../deplo-move/schema-tag";
import {
  MOVE_TABLES,
  copyOrder,
  copyPolicy,
  mergeForeignColumns,
  quoteIdent,
  serverColumns,
  tableShapes,
} from "../../deplo-move/tables";
import {
  isLoopbackIp,
  rehostWildcard,
  wildcardEmbeddedIp,
} from "../../deploy/domains";
import { parseHostAddress } from "../../host-address";
import { serverIpv4 } from "../servers/addresses";
import { listAllServers } from "../servers/roster";
import { isSealed, resultRows, sealValue } from "./rekey";

export { schemaTag };

export interface RestoreResult {
  rows: number;
  unreadable: number;
}

export interface RestoreOptions {
  // Each of the old Deplo's servers -> the server here that takes its place. Null or missing leaves it out.
  serverMap: ReadonlyMap<string, string | null>;
  // The old Deplo's address: every copied backup run is marked as its.
  peerUrl: string;
  // Runs inside the open transaction: never await a write to this database from it.
  onRows?: (rows: number) => void;
}

// One of this Deplo's servers: every one survives the wipe.
export interface KeptServer {
  id: string;
  name: string;
  fingerprint: string | null;
}

type Row = Record<string, unknown>;
type RowsFrame = Extract<DumpFrame, { kind: "rows" }>;

interface OldServer {
  name: string;
  ipv4: string | null;
  allTeams: boolean;
}

// What the copy learns on the way in and settles once every table is in.
interface Copy {
  opts: RestoreOptions;
  kept: KeptServer[];
  targetIps: Map<string, string | null>;
  oldServers: Map<string, OldServer>;
  oldGrants: { serverId: string; teamId: string }[];
  appServers: Map<string, { from: string; to: string; url: string | null }>;
  later: Map<string, Row[]>;
}

const BATCH = 500;
const CUT =
  "The copy from the old Deplo stopped before it finished. Nothing was changed here; try again.";
const DAMAGED =
  "The copy from the old Deplo arrived damaged. Nothing was changed here; try again.";
const MISMATCH =
  "The two Deplos are on different versions. Update both to the same version, then try again.";
const NO_PEER = "This move lost its connection to the old Deplo.";
const TARGET_GONE =
  "A server chosen for the copy is no longer on this Deplo. Choose again, then try again.";

// Empties every copied table but `servers`: each of this Deplo's servers stays, open to every team again.
export async function wipeForMove(
  tx: DbTx,
): Promise<{ keptServers: KeptServer[] }> {
  for (const [table, policy] of Object.entries(MOVE_TABLES))
    if (policy.kind === "skip" && policy.clear)
      await tx.execute(sql.raw(`delete from ${quoteIdent(table)}`));
  for (const table of [...copyOrder()].reverse()) {
    const t = quoteIdent(table);
    if (copyPolicy(table).keepTarget) {
      const set = mergeForeignColumns(table).map(
        (c) => `${quoteIdent(c)} = null`,
      );
      if (set.length)
        await tx.execute(sql.raw(`update ${t} set ${set.join(", ")}`));
    } else if (table === "servers") {
      await tx.update(serversTable).set({ allTeams: true });
    } else {
      await tx.execute(sql.raw(`delete from ${t}`));
    }
  }
  const keptServers = await tx
    .select({
      id: serversTable.id,
      name: serversTable.name,
      fingerprint: serversTable.agentCertFingerprint,
    })
    .from(serversTable);
  return {
    keptServers: keptServers.map((s) => ({
      ...s,
      fingerprint: s.fingerprint || null,
    })),
  };
}

// Replaces this Deplo's data with the old one's, in one transaction: a cut stream changes nothing.
export async function restoreInstance(
  lines: AsyncIterable<string>,
  opts: RestoreOptions,
): Promise<RestoreResult> {
  const frames = readFrames(lines);
  try {
    const first = await frames.next();
    const order = checkBegin(first.done ? undefined : first.value);
    if (!opts.peerUrl.trim()) throw new Error(NO_PEER);
    const targetIps = await placeTargets(opts.serverMap);
    return await getDb().transaction(async (tx) => {
      const { keptServers } = await wipeForMove(tx);
      const copy: Copy = {
        opts,
        kept: keptServers,
        targetIps,
        oldServers: new Map(),
        oldGrants: [],
        appServers: new Map(),
        later: new Map(),
      };
      let at = 0;
      let rows = 0;
      let unreadable = 0;
      for (;;) {
        const next = await frames.next();
        if (next.done) throw new Error(CUT);
        const frame = next.value;
        if (frame.kind === "end") {
          if (frame.rows !== rows || frame.unreadable !== unreadable)
            throw new Error(CUT);
          break;
        }
        if (frame.kind !== "rows" || !Array.isArray(frame.rows))
          throw new Error(DAMAGED);
        const index = order.indexOf(frame.table);
        if (index < at) throw new Error(DAMAGED);
        at = index;
        const lost = frame.unreadable ?? [];
        rows += frame.rows.length;
        unreadable += lost.length;
        await insertFrame(tx, { ...frame, unreadable: lost }, copy);
        opts.onRows?.(rows);
      }
      await applyDeferred(tx, copy.later);
      await applyServerAccess(tx, copy);
      await rehostGeneratedNames(tx, copy);
      await restartSequences(tx, order);
      return { rows, unreadable };
    });
  } finally {
    await frames.return(undefined).catch(() => {});
  }
}

async function* readFrames(
  lines: AsyncIterable<string>,
): AsyncGenerator<DumpFrame> {
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let frame: DumpFrame;
    try {
      frame = JSON.parse(line) as DumpFrame;
    } catch {
      throw new Error(DAMAGED);
    }
    yield frame;
  }
}

function checkBegin(frame: DumpFrame | undefined): string[] {
  if (frame?.kind !== "begin") throw new Error(DAMAGED);
  if (frame.protocol !== MOVE_PROTOCOL) throw new Error(MISMATCH);
  const ours = schemaTag();
  if (frame.schema !== ours) {
    const older =
      parseInt(frame.schema, 10) < parseInt(ours, 10)
        ? "the old Deplo"
        : "this Deplo";
    throw new Error(
      `The two Deplos are on different versions. Update ${older} first, then try again.`,
    );
  }
  const order = copyOrder();
  if (JSON.stringify(frame.tables) !== JSON.stringify(order))
    throw new Error(MISMATCH);
  return order;
}

// Every server the map names exists here; each one's IPv4, for the generated names that move onto it.
async function placeTargets(
  serverMap: ReadonlyMap<string, string | null>,
): Promise<Map<string, string | null>> {
  const here = new Map((await listAllServers()).map((s) => [s.id, s]));
  const ips = new Map<string, string | null>();
  for (const id of serverMap.values()) {
    if (!id || ips.has(id)) continue;
    const server = here.get(id);
    if (!server) throw new Error(TARGET_GONE);
    ips.set(id, await serverIpv4(server).catch(() => null));
  }
  return ips;
}

function literalIpv4(row: Row): string | null {
  for (const raw of [row.ip, row.host]) {
    const a = parseHostAddress(typeof raw === "string" ? raw : null);
    if (a?.kind === "ipv4" && !isLoopbackIp(a.host)) return a.host;
  }
  return null;
}

async function insertFrame(
  tx: DbTx,
  frame: RowsFrame,
  copy: Copy,
): Promise<void> {
  const { table } = frame;
  const policy = copyPolicy(table);
  const shape = tableShapes().get(table)!;
  const lost = new Set(frame.unreadable.map(([i, c]) => `${i}:${c}`));
  const rekey = Object.entries(policy.rekey ?? {});
  for (const [i, row] of frame.rows.entries()) {
    for (const c of policy.nullOnCopy ?? []) row[c] = null;
    for (const [c, key] of rekey) {
      const value = row[c];
      if (isSealed(value) && !lost.has(`${i}:${c}`))
        row[c] = await sealValue(key, value);
    }
  }
  if (policy.mapped) return readMapped(table, frame.rows, copy);
  const rows = frame.rows.filter((row) => placeRow(table, row, copy));
  const deferred = policy.deferred ?? [];
  for (const row of rows) {
    if (table === "backup_runs") row.copied_from ??= copy.opts.peerUrl;
    if (deferred.some((c) => row[c] != null)) {
      const keep: Row = {};
      for (const c of [...shape.primaryKey, ...deferred]) keep[c] = row[c];
      if (!copy.later.has(table)) copy.later.set(table, []);
      copy.later.get(table)!.push(keep);
      for (const c of deferred) row[c] = null;
    }
  }
  if (rows.length === 0) return;
  const t = sql.raw(quoteIdent(table));
  let merge = sql.raw("");
  if (policy.keepTarget) {
    const skip = new Set([...shape.primaryKey, ...policy.keepTarget]);
    const set = shape.columns
      .filter((c) => !skip.has(c))
      .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`);
    const key = shape.primaryKey.map(quoteIdent).join(", ");
    merge = sql.raw(` on conflict (${key}) do update set ${set.join(", ")}`);
  } else if (serverColumns(table).some((c) => shape.primaryKey.includes(c))) {
    // Two old servers placed on one server here make their rows one.
    merge = sql.raw(" on conflict do nothing");
  }
  await tx.execute(
    sql`insert into ${t} overriding system value select * from json_populate_recordset(null::${t}, ${JSON.stringify(rows)}::json)${merge}`,
  );
}

function readMapped(table: string, rows: Row[], copy: Copy): void {
  if (table === "server_teams") {
    for (const r of rows)
      copy.oldGrants.push({
        serverId: String(r.server_id),
        teamId: String(r.team_id),
      });
    return;
  }
  refuseOurServers(rows, copy.kept);
  for (const r of rows)
    copy.oldServers.set(String(r.id), {
      name: String(r.name),
      ipv4: literalIpv4(r),
      allTeams: r.all_teams !== false,
    });
}

// Rewrites every server the row names through the map; false drops a row that cannot do without its server.
function placeRow(table: string, row: Row, copy: Copy): boolean {
  const policy = copyPolicy(table);
  const notNull = tableShapes().get(table)!.notNull;
  for (const c of serverColumns(table)) {
    const from = row[c];
    if (typeof from !== "string") continue;
    const to = copy.opts.serverMap.get(from) ?? null;
    if (to) {
      row[c] = to;
      if (table === "apps" && c === "server_id")
        copy.appServers.set(String(row.id), {
          from,
          to,
          url:
            typeof row.production_url === "string" ? row.production_url : null,
        });
      continue;
    }
    if (policy.needsServer?.includes(c))
      throw new Error(leftOut(row, copy.oldServers.get(from)?.name ?? from));
    if (notNull.has(c)) return false;
    row[c] = null;
  }
  return true;
}

function leftOut(row: Row, server: string): string {
  const what =
    typeof row.name === "string" && row.name ? `"${row.name}"` : "Something";
  return `${what} is on the old server "${server}", which this copy leaves out. Choose a server here for it, then try again.`;
}

function refuseOurServers(rows: Row[], kept: KeptServer[]): void {
  for (const row of rows) {
    const fingerprint = row.agent_cert_fingerprint;
    const ours = kept.find(
      (k) =>
        k.id === row.id ||
        (k.fingerprint !== null && k.fingerprint === fingerprint),
    );
    if (ours)
      throw new Error(
        `This Deplo's server "${ours.name}" is also the old Deplo's server "${String(row.name)}". Copy onto a machine the old Deplo does not use.`,
      );
  }
}

async function applyDeferred(
  tx: DbTx,
  later: Map<string, Row[]>,
): Promise<void> {
  for (const [table, rows] of later) {
    const shape = tableShapes().get(table)!;
    const t = sql.raw(quoteIdent(table));
    const set = sql.raw(
      (copyPolicy(table).deferred ?? [])
        .map((c) => `${quoteIdent(c)} = v.${quoteIdent(c)}`)
        .join(", "),
    );
    const match = sql.raw(
      shape.primaryKey
        .map((c) => `t.${quoteIdent(c)} = v.${quoteIdent(c)}`)
        .join(" and "),
    );
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = JSON.stringify(rows.slice(i, i + BATCH));
      await tx.execute(
        sql`update ${t} as t set ${set} from json_populate_recordset(null::${t}, ${batch}::json) as v where ${match}`,
      );
    }
  }
}

// A server here gets the team access of the old servers it replaces together: every team if one had it.
async function applyServerAccess(tx: DbTx, copy: Copy): Promise<void> {
  const replaced = new Map<string, string[]>();
  for (const [from, to] of copy.opts.serverMap)
    if (to && copy.oldServers.has(from))
      replaced.set(to, [...(replaced.get(to) ?? []), from]);
  for (const [to, olds] of replaced) {
    const allTeams = olds.some((o) => copy.oldServers.get(o)!.allTeams);
    await tx
      .update(serversTable)
      .set({ allTeams })
      .where(eq(serversTable.id, to));
    const teams = new Set(
      copy.oldGrants
        .filter((g) => olds.includes(g.serverId))
        .map((g) => g.teamId),
    );
    if (teams.size)
      await tx
        .insert(serverTeams)
        .values([...teams].map((teamId) => ({ serverId: to, teamId })))
        .onConflictDoNothing();
  }
}

// A generated name embeds its server's IPv4, so one minted for the old server would answer from there.
async function rehostGeneratedNames(tx: DbTx, copy: Copy): Promise<void> {
  const moved = new Map<string, { from: string; to: string }>();
  for (const [appId, s] of copy.appServers) {
    const from = copy.oldServers.get(s.from)?.ipv4;
    const to = copy.targetIps.get(s.to);
    if (from && to && from !== to) moved.set(appId, { from, to });
  }
  if (moved.size === 0) return;
  const rehost = (host: string, ip: { from: string; to: string }) =>
    wildcardEmbeddedIp(host) === ip.from ? rehostWildcard(host, ip.to) : host;
  const domains = resultRows<{ id: string; app_id: string; name: string }>(
    await tx.execute(
      sql`select id, app_id, name from domains where source = 'auto' and app_id in ${[...moved.keys()]}`,
    ),
  );
  for (const d of domains) {
    const name = rehost(d.name, moved.get(d.app_id)!);
    if (name === d.name) continue;
    // A name already taken here stays as it was rather than failing the whole copy.
    await tx.execute(sql`
      update domains as t set name = ${name} where t.id = ${d.id} and not exists (
        select 1 from domains o where o.name = ${name}
          and coalesce(o.path_prefix, '') = coalesce(t.path_prefix, ''))`);
  }
  for (const [appId, ip] of moved) {
    const url = copy.appServers.get(appId)!.url;
    if (!url) continue;
    const next = url.replace(
      /^(https?:\/\/)([^/]+)/,
      (_m, scheme: string, host: string) => scheme + rehost(host, ip),
    );
    if (next !== url)
      await tx.execute(
        sql`update apps set production_url = ${next} where id = ${appId}`,
      );
  }
}

// Every identity column carries on after the highest value copied.
async function restartSequences(tx: DbTx, tables: string[]): Promise<void> {
  const columns = resultRows<{ table_name: string; column_name: string }>(
    await tx.execute(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = current_schema()
        and (is_identity = 'YES' or column_default like 'nextval(%')`),
  );
  for (const { table_name: table, column_name: column } of columns) {
    if (!tables.includes(table)) continue;
    const t = quoteIdent(table);
    await tx.execute(
      sql`select setval(pg_get_serial_sequence(${t}, ${column}), coalesce(max(${sql.raw(quoteIdent(column))}), 0) + 1, false) from ${sql.raw(t)}`,
    );
  }
}

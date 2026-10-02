import "server-only";

import { sql } from "drizzle-orm";

import { getDb, type DbTx } from "../../db/client";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import { MOVE_PROTOCOL, type DumpFrame } from "../../deplo-move/protocol";
import { schemaTag } from "../../deplo-move/schema-tag";
import {
  MOVE_TABLES,
  copyOrder,
  copyPolicy,
  mergeForeignColumns,
  quoteIdent,
  tableShapes,
} from "../../deplo-move/tables";
import { isSealed, resultRows, sealValue } from "./rekey";

export { schemaTag };

export interface RestoreResult {
  rows: number;
  unreadable: number;
}

export interface RestoreOptions {
  // Runs inside the open transaction: never await a write to this database from it.
  onRows?: (rows: number) => void;
}

// This machine's own server row: it survives the wipe, and the old Deplo's rows must not collide with it.
export interface KeptServer {
  id: string;
  name: string;
  fingerprint: string | null;
}

type Row = Record<string, unknown>;
type RowsFrame = Extract<DumpFrame, { kind: "rows" }>;

const BATCH = 500;
const CUT =
  "The copy from the old Deplo stopped before it finished. Nothing was changed here; try again.";
const DAMAGED =
  "The copy from the old Deplo arrived damaged. Nothing was changed here; try again.";
const MISMATCH =
  "The two Deplos are on different versions. Update both to the same version, then try again.";

// Empties every copied table except this machine's own server row; merged tables keep their rows.
export async function wipeForMove(
  tx: DbTx,
): Promise<{ keptServers: KeptServer[] }> {
  const keptServers = await ownServers(tx);
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
    } else if (table === "servers" && keptServers.length > 0) {
      const ids = keptServers.map((s) => s.id);
      await tx.execute(sql`delete from servers where id not in ${ids}`);
    } else {
      await tx.execute(sql.raw(`delete from ${t}`));
    }
  }
  return { keptServers };
}

async function ownServers(tx: DbTx): Promise<KeptServer[]> {
  const self = deploHostSelfAddresses();
  const rows = resultRows<{
    id: string;
    name: string;
    ip: string | null;
    host: string | null;
    agent_cert_fingerprint: string | null;
  }>(
    await tx.execute(
      sql`select id, name, ip, host, agent_cert_fingerprint from servers`,
    ),
  );
  return rows
    .filter((s) =>
      isDeploHostServer(
        { ip: s.ip ?? undefined, host: s.host ?? undefined },
        self,
      ),
    )
    .map((s) => ({
      id: s.id,
      name: s.name,
      fingerprint: s.agent_cert_fingerprint || null,
    }));
}

// Replaces this Deplo's data with the old one's, in one transaction: a cut stream changes nothing.
export async function restoreInstance(
  lines: AsyncIterable<string>,
  opts: RestoreOptions = {},
): Promise<RestoreResult> {
  const frames = readFrames(lines);
  try {
    const first = await frames.next();
    const order = checkBegin(first.done ? undefined : first.value);
    return await getDb().transaction(async (tx) => {
      const { keptServers } = await wipeForMove(tx);
      const later = new Map<string, Row[]>();
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
        await insertFrame(
          tx,
          { ...frame, unreadable: lost },
          keptServers,
          later,
        );
        rows += frame.rows.length;
        unreadable += lost.length;
        opts.onRows?.(rows);
      }
      await applyDeferred(tx, later);
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

async function insertFrame(
  tx: DbTx,
  frame: RowsFrame,
  keptServers: KeptServer[],
  later: Map<string, Row[]>,
): Promise<void> {
  const { table, rows } = frame;
  const policy = copyPolicy(table);
  const shape = tableShapes().get(table)!;
  const lost = new Set(frame.unreadable.map(([i, c]) => `${i}:${c}`));
  const rekey = Object.entries(policy.rekey ?? {});
  const deferred = policy.deferred ?? [];
  for (const [i, row] of rows.entries()) {
    for (const c of policy.nullOnCopy ?? []) row[c] = null;
    for (const [c, key] of rekey) {
      const value = row[c];
      if (isSealed(value) && !lost.has(`${i}:${c}`))
        row[c] = await sealValue(key, value);
    }
    if (deferred.some((c) => row[c] != null)) {
      const keep: Row = {};
      for (const c of [...shape.primaryKey, ...deferred]) keep[c] = row[c];
      if (!later.has(table)) later.set(table, []);
      later.get(table)!.push(keep);
      for (const c of deferred) row[c] = null;
    }
  }
  if (table === "servers") refuseThisMachine(rows, keptServers);
  const t = sql.raw(quoteIdent(table));
  let merge = sql.raw("");
  if (policy.keepTarget) {
    const skip = new Set([...shape.primaryKey, ...policy.keepTarget]);
    const set = shape.columns
      .filter((c) => !skip.has(c))
      .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`);
    const key = shape.primaryKey.map(quoteIdent).join(", ");
    merge = sql.raw(` on conflict (${key}) do update set ${set.join(", ")}`);
  }
  await tx.execute(
    sql`insert into ${t} overriding system value select * from json_populate_recordset(null::${t}, ${JSON.stringify(rows)}::json)${merge}`,
  );
}

function refuseThisMachine(rows: Row[], keptServers: KeptServer[]): void {
  for (const row of rows) {
    const fingerprint = row.agent_cert_fingerprint;
    const clash = keptServers.some(
      (k) =>
        k.id === row.id ||
        (k.fingerprint !== null && k.fingerprint === fingerprint),
    );
    if (clash)
      throw new Error(
        `The old Deplo has this machine as its server "${String(row.name)}". Move to a machine that is not one of its servers.`,
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

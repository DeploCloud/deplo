import "server-only";

import { sql } from "drizzle-orm";

import { getDb, type DbTx } from "../../db/client";
import { MOVE_PROTOCOL, type DumpFrame } from "../../deplo-move/protocol";
import { schemaTag } from "../../deplo-move/schema-tag";
import { copyOrder, copyPolicy, quoteIdent } from "../../deplo-move/tables";
import { isSealed, openValue, resultRows } from "./rekey";

const BATCH = 500;
const CURSOR = "deplo_move_dump";

// Every copied table as NDJSON frames from one snapshot, secrets OPENED: serve it only behind the move code.
export async function* dumpInstance(): AsyncIterable<string> {
  const pipe = new LinePipe();
  const done = getDb()
    .transaction((tx) => writeDump(tx, (line) => pipe.write(line)), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    })
    .then(
      () => pipe.end(),
      (err: unknown) => pipe.end(err),
    );
  try {
    for (let line = await pipe.read(); line !== null; line = await pipe.read())
      yield line;
  } finally {
    pipe.stop();
    await done;
  }
}

async function writeDump(
  tx: DbTx,
  emit: (line: string) => Promise<void>,
): Promise<void> {
  const tables = copyOrder();
  const frame = (f: DumpFrame) => emit(JSON.stringify(f));
  await frame({
    kind: "begin",
    protocol: MOVE_PROTOCOL,
    schema: schemaTag(),
    tables,
  });
  let rows = 0;
  let unreadable = 0;
  for (const table of tables) {
    await tx.execute(
      sql.raw(
        `declare ${CURSOR} no scroll cursor for select row_to_json(t)::text as j from ${quoteIdent(table)} t`,
      ),
    );
    for (;;) {
      const batch = resultRows<{ j: string }>(
        await tx.execute(sql.raw(`fetch ${BATCH} from ${CURSOR}`)),
      ).map((r) => JSON.parse(r.j) as Record<string, unknown>);
      if (batch.length === 0) break;
      const lost = await openSecrets(table, batch);
      rows += batch.length;
      unreadable += lost.length;
      await frame({ kind: "rows", table, rows: batch, unreadable: lost });
    }
    await tx.execute(sql.raw(`close ${CURSOR}`));
  }
  await frame({ kind: "end", rows, unreadable });
}

// Opens re-keyed values in place; a value that will not open stays ciphertext and is reported.
async function openSecrets(
  table: string,
  rows: Record<string, unknown>[],
): Promise<[number, string][]> {
  const rekey = Object.entries(copyPolicy(table).rekey ?? {});
  const lost: [number, string][] = [];
  if (rekey.length === 0) return lost;
  for (const [i, row] of rows.entries()) {
    for (const [column, key] of rekey) {
      const value = row[column];
      if (!isSealed(value)) continue;
      const plain = await openValue(key, value);
      if (plain === null) lost.push([i, column]);
      else row[column] = plain;
    }
  }
  return lost;
}

const STOPPED = "The copy was stopped before it finished.";

// Hands one line at a time from the transaction to the reader, so the cursor reads only as fast as the copy is sent.
class LinePipe {
  private line: string | null = null;
  private ended = false;
  private failure: unknown = undefined;
  private stopped = false;
  private wakeReader: (() => void) | null = null;
  private wakeWriter: (() => void) | null = null;

  async write(line: string): Promise<void> {
    if (this.stopped) throw new Error(STOPPED);
    this.line = line;
    this.wake("reader");
    await new Promise<void>((resolve) => (this.wakeWriter = resolve));
    if (this.stopped) throw new Error(STOPPED);
  }

  async read(): Promise<string | null> {
    while (this.line === null) {
      if (this.ended) {
        if (this.failure !== undefined) throw this.failure;
        return null;
      }
      await new Promise<void>((resolve) => (this.wakeReader = resolve));
    }
    const line = this.line;
    this.line = null;
    this.wake("writer");
    return line;
  }

  end(failure?: unknown): void {
    this.ended = true;
    this.failure = failure;
    this.wake("reader");
  }

  stop(): void {
    this.stopped = true;
    this.wake("writer");
  }

  private wake(who: "reader" | "writer"): void {
    const fn = who === "reader" ? this.wakeReader : this.wakeWriter;
    if (who === "reader") this.wakeReader = null;
    else this.wakeWriter = null;
    fn?.();
  }
}

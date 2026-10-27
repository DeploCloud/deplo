// Next exits as soon as its server closes; until `work` settles (or `capMs` passes) that exit waits.
export function holdExitUntil(work: Promise<unknown>, capMs: number): void {
  const exit = process.exit.bind(process);
  const settled = Promise.race([
    work.catch(() => {}),
    new Promise((r) => setTimeout(r, capMs).unref()),
  ]);
  process.exit = ((code?: number | string | null) => {
    void settled.finally(() => exit(code));
  }) as typeof process.exit;
}

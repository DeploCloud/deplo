/**
 * Merge a re-tailed log burst into what the viewer already shows.
 *
 * `docker logs -f` ends when the container dies, so following a crash-looping
 * container means reattaching after every restart — and each reattach replays
 * `docker logs --tail`, most of which is already on screen. Appending it blindly
 * stutters the same stack trace once per loop; dropping it loses the new run.
 *
 * The burst is a window onto the same log file we were already reading, so the
 * alignment is a SUFFIX/PREFIX overlap: find the longest tail of what we show
 * that is also the head of the burst, and append only what follows it. It has to
 * be an overlap and not a substring search — a crash loop prints the same lines
 * every iteration, so "find our text in the burst" happily matches the REPLAY of
 * the previous run and then throws away the new one.
 *
 * No overlap at all means our lines have scrolled out of docker's tail window
 * (or this is a fresh container), and every byte of the burst is new.
 *
 * Pure and synchronous — the caller is a React state updater.
 */

/**
 * How far back to look for the overlap. Comfortably longer than the replayed
 * tail (500 lines) so a full replay always aligns; past this we would rather
 * repeat a few lines than scan a megabyte of history on every chunk.
 */
const MAX_OVERLAP_CHARS = 128_000;

export function mergeLogBurst(previous: string, burst: string): string {
  if (!previous) return burst;
  if (!burst) return previous;

  const tail = previous.slice(-MAX_OVERLAP_CHARS);
  return previous + burst.slice(overlapLength(tail, burst));
}

/** Length of the longest suffix of `tail` that is a prefix of `burst`. */
function overlapLength(tail: string, burst: string): number {
  const lastChar = tail.charCodeAt(tail.length - 1);
  const max = Math.min(tail.length, burst.length);

  for (let k = max; k > 0; k--) {
    // The overlap has to END where our text ends, so the burst's k-th character
    // must be our last one. A single char test rules out almost every k before
    // paying for the full comparison.
    if (burst.charCodeAt(k - 1) !== lastChar) continue;

    const offset = tail.length - k;
    let matches = true;
    for (let i = 0; i < k - 1; i++) {
      if (tail.charCodeAt(offset + i) !== burst.charCodeAt(i)) {
        matches = false;
        break;
      }
    }
    if (matches) return k;
  }
  return 0;
}

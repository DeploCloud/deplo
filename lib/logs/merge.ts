/**
 * Merge a re-tailed log burst into what the viewer already shows.
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

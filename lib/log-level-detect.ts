import type { LogLevel } from "./types";

/**
 * Heuristic log-level detection for RAW log lines that arrive without a level
 * tag — i.e. a container's stdout/stderr from `docker logs -f`. Unlike build
 * logs (whose producer already stamps a {@link LogLevel}), container output is
 * an unstructured byte stream: Docker keeps no severity, so the only signal is
 * the line text itself. We classify it the way Dozzle/Dokploy do — pattern
 * matching — so the runtime-logs pane can render the same level pills/tints as
 * the build-log stream via the shared `lib/log-levels.ts` styling.
 *
 * This is a guess, not ground truth. Free-text logs have no universal format, so
 * mis-classification is expected on adversarial lines ("no errors found"); the
 * goal is that the *common* shapes (`[ERROR]`, `level=warn`, a stack-trace `at`
 * frame, an HTTP 5xx) light up usefully.
 *
 * Vocabulary note: deplo's {@link LogLevel} has no "warning"/"trace"/"fatal" —
 * everything folds into `error | warn | info | debug | success` (the `command`
 * level is producer-only and never inferred here). Order matters: the first
 * matching block wins, mirroring how a reader skims a line.
 */

/** Pull an HTTP status code out of common shapes and map it to a severity. */
function levelFromStatusCode(message: string): LogLevel | null {
  // `"statusCode": 503` (JSON), `status=404` / `status:500` (key=value), or a
  // bare ` 200 ` / `… 502` token as access logs print it (bounded by space or
  // line edge). The bare-token form deliberately also matches a 3-digit count
  // ("Loaded 200 routes" reads as success) — we accept that false positive to
  // colour plain access logs (`GET /x 500`), which is the common, useful case.
  const match = message.match(
    /(?:"?status(?:Code)?"?\s*[:=]\s*"?(\d{3})"?)|(?:(?:^|\s)(\d{3})(?:\s|$))/i,
  );
  if (!match) return null;
  const code = Number(match[1] ?? match[2]);
  if (code >= 500) return "error";
  if (code >= 400) return "warn";
  if (code >= 200 && code < 300) return "success";
  if (code >= 300) return "info"; // 3xx redirects
  return null;
}

/**
 * Classify a single raw log line. Pass the PLAIN line (ANSI already stripped) —
 * escape codes would otherwise leak into the regexes (e.g. a `[0m` reset
 * masquerading as a `[…]`-bracketed tag).
 */
export function detectLogLevel(message: string): LogLevel {
  // 1. Structured status code first — it's the strongest single signal and a
  //    2xx line shouldn't read as "error" just because a word later matches.
  const byStatus = levelFromStatusCode(message);
  if (byStatus) return byStatus;

  const m = message;

  // 2. ERROR — checked before warn/info so a genuine failure isn't downgraded.
  //    Each clause is anchored (bracket tag, key=value, line-start token, or a
  //    structural shape like a stack frame) to avoid the greedy bare-word
  //    matching that makes "no failures here" read as an error.
  if (
    /(?:^|\s)(?:error|err|fatal|panic|critical)\s*[:=]/i.test(m) || // `error:` `err=`
    /\[(?:error|err|fatal|critical|panic)\]/i.test(m) || // `[ERROR]`
    /\b(?:level|lvl|severity)\s*[:=]\s*"?(?:error|err|fatal|critical|panic)\b/i.test(
      m,
    ) || // `level=error`
    /\b(?:uncaught|unhandled)\s+(?:exception|error|rejection)\b/i.test(m) ||
    /(?:^|\s)(?:exception|traceback)\b/i.test(m) || // Python `Traceback`, Java `Exception`
    /^\s*at\s+[\w.$]+\s*\(?.*:\d+(?::\d+)?\)?/.test(m) || // JS/Java stack frame
    /\b[A-Za-z.]*(?:Error|Exception)\b\s*:/.test(m) || // `TypeError:` `IOException:`
    /\b(?:errno|code)\s*[:=]\s*(?:-?\d+|E[A-Z]+)\b/.test(m) // `errno=2` `code: ECONNREFUSED`
  ) {
    return "error";
  }

  // 3. WARN
  if (
    /(?:^|\s)(?:warn(?:ing)?)\s*[:=]/i.test(m) || // `warn:` `warning =`
    /\[(?:warn(?:ing)?)\]/i.test(m) || // `[WARN]`
    /\b(?:level|lvl|severity)\s*[:=]\s*"?(?:warn(?:ing)?)\b/i.test(m) ||
    /\bdeprecat(?:ed|ion)\b/i.test(m) ||
    /\b(?:caution|notice)\s*[:=]/i.test(m) ||
    /[‼⚠]️?/.test(m) // ⚠ / ⚠️ / ‼
  ) {
    return "warn";
  }

  // 4. SUCCESS — positive completion phrasing and the "now serving" lines that
  //    mark a healthy startup, plus check-mark glyphs.
  if (
    /\[(?:success|ok|done)\]/i.test(m) ||
    /\b(?:successfully|completed?)\s+(?:initialized|started|created|deployed|built|connected|compiled)\b/i.test(
      m,
    ) ||
    /\b(?:listening|running|serving)\s+(?:on|at)\b/i.test(m) || // `listening on :8080`
    /\brunning\b/i.test(m) || // any "running" line — healthy/up state
    /\b(?:server\s+(?:is\s+)?ready|ready\s+in|compiled\s+successfully)\b/i.test(
      m,
    ) ||
    /[✓√✔✅]/.test(m)
  ) {
    return "success";
  }

  // 5. DEBUG / TRACE — explicit debug tags only; everything else falls to info.
  if (
    /(?:^|\s)(?:debug|trace|verbose|dbg)\s*[:=]/i.test(m) ||
    /\[(?:debug|trace|verbose)\]/i.test(m) ||
    /\b(?:level|lvl|severity)\s*[:=]\s*"?(?:debug|trace|verbose)\b/i.test(m)
  ) {
    return "debug";
  }

  // 6. INFO — explicit info/notice tags; the default for anything unmatched.
  return "info";
}

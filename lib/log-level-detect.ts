import type { LogLevel } from "./types";

/**
 * Level detection for RAW log lines that arrive without a level tag - a
 * container's stdout/stderr from `docker logs -f`, and a build's output, which the
 * agent forwards verbatim under a blanket `info` (only the lines Deplo itself
 * writes into a build's sink carry an authored level, so `loadDeploymentLogs`
 * re-reads the rest through here).
 */

/**
 * Level words as every mainstream logger spells them, folded onto Deplo's five.
 */
const LEVEL_WORDS: Record<string, LogLevel> = {
  trc: "debug",
  trace: "debug",
  debug: "debug",
  dbg: "debug",
  verbose: "debug",
  inf: "info",
  info: "info",
  information: "info",
  notice: "info",
  log: "info",
  wrn: "warn",
  warn: "warn",
  warning: "warn",
  err: "error",
  eror: "error",
  error: "error",
  fatal: "error",
  crit: "error",
  critical: "error",
  panic: "error",
  alert: "error",
  emerg: "error",
  emergency: "error",
  severe: "error",
};

function levelWord(word: string | undefined): LogLevel | null {
  return word ? (LEVEL_WORDS[word.toLowerCase()] ?? null) : null;
}

/**
 * A numeric level, on whichever of the two scales the number can only belong to.
 * pino/bunyan use 10/20/30/40/50/60; syslog uses 0-7.
 */
function levelFromNumber(n: number): LogLevel | null {
  if (n >= 10) {
    if (n >= 50) return "error";
    if (n >= 40) return "warn";
    if (n >= 30) return "info";
    return "debug";
  }
  if (n <= 7) {
    if (n <= 3) return "error"; // emerg / alert / crit / err
    if (n === 4) return "warn";
    if (n <= 6) return "info"; // notice / info
    return "debug";
  }
  return null;
}

const LEVEL_KEY = "level|severity|levelname|loglevel|log\\.level|lvl";

/** `"level":"error"` / `"severity":"WARN"` / `"log.level":"debug"` - JSON. */
const JSON_LEVEL = new RegExp(
  `"(?:${LEVEL_KEY})"\\s*:\\s*"([A-Za-z]{3,11})"`,
  "i",
);

/** `"level":50` - pino's numeric scale, or syslog's, inside a JSON log line. */
const JSON_LEVEL_NUM = new RegExp(
  `"(?:${LEVEL_KEY})"\\s*:\\s*(\\d{1,2})(?![\\d.])`,
  "i",
);

/** logfmt, as Go's slog / zap's console encoder / Traefik's text mode print it. */
const LOGFMT_LEVEL = new RegExp(
  `(?:^|\\s)(?:${LEVEL_KEY})\\s*=\\s*"?([A-Za-z]{3,11})"?(?=[\\s,;}\\])]|$)`,
  "i",
);

/**
 * Every `[bracketed]` word in the line, in order. Scanned as a LIST rather than
 * matched once because the level is routinely not the first bracket: logback
 * prints `[main] INFO com.acme - up`, and Postgres prints `[1] LOG: ready`.
 */
const BRACKET_WORDS = /\[\s*([A-Za-z]{3,11})\s*\]/g;

/**
 * A `word:` tag, wherever it sits on the line.
 */
const TAGGED_WORDS = /(?:^|[\s\]|>])([A-Za-z]{3,11})\s*:(?!\/)/g;

/** glog / klog, which is what Go core tooling, kubelet and containerd emit. */
const GLOG = /^([EWIF])\d{4}\s+\d{2}:\d{2}:\d{2}/;
const GLOG_LEVEL: Record<string, LogLevel> = {
  E: "error",
  F: "error",
  W: "warn",
  I: "info",
};

/**
 * A bare UPPERCASE level word standing as its own column - how logback, log4j,
 * Serilog and Spring Boot lay a line out: `2026-08-24 10:00:00.000 INFO 1 ---
 * [main] c.a.App : started`.
 */
const COLUMN_LEVEL =
  /(?:^|\s)(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE|NOTICE)(?=\s)/;
const COLUMN_LEVEL_WINDOW = 64;

/** A syslog priority frame, `<11>Aug 24 ...`. severity = PRI mod 8. */
const SYSLOG_PRI = /^<(\d{1,3})>/;

/** npm/pnpm/yarn write their level as a literal prefix, not a tag. */
// `\b` is wrong after `ERR!`: `!` and the space that follows are both
// non-word characters, so there is no boundary between them.
const NPM_PREFIX = /^\s*(?:npm|pnpm|yarn)\s+(ERR!|WARN|warning|notice)(?=\s|$)/;

/**
 * Tier 1 - the producer stated the level.
 */
function declaredLevel(m: string): LogLevel | null {
  const glog = GLOG.exec(m);
  if (glog) return GLOG_LEVEL[glog[1]] ?? null;

  const pri = SYSLOG_PRI.exec(m);
  if (pri) {
    const byPri = levelFromNumber(Number(pri[1]) % 8);
    if (byPri) return byPri;
  }

  const npm = NPM_PREFIX.exec(m);
  if (npm) {
    if (npm[1] === "ERR!") return "error";
    return npm[1] === "notice" ? "info" : "warn";
  }

  const json = levelWord(JSON_LEVEL.exec(m)?.[1]);
  if (json) return json;

  const jsonNum = JSON_LEVEL_NUM.exec(m);
  if (jsonNum) {
    const byNum = levelFromNumber(Number(jsonNum[1]));
    if (byNum) return byNum;
  }

  const logfmt = levelWord(LOGFMT_LEVEL.exec(m)?.[1]);
  if (logfmt) return logfmt;

  return (
    firstLevelWord(m, BRACKET_WORDS) ??
    firstLevelWord(m, TAGGED_WORDS) ??
    levelWord(COLUMN_LEVEL.exec(m.slice(0, COLUMN_LEVEL_WINDOW))?.[1])
  );
}

/** Walk a global regex over the line and return the first capture that is a
 *  known level word, ignoring the ones that are not. */
function firstLevelWord(m: string, re: RegExp): LogLevel | null {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(m)) !== null) {
    const level = levelWord(match[1]);
    if (level) return level;
  }
  return null;
}

/**
 * Tier 2 - shapes that mean one thing and nothing else.
 */
const KNOWN_ERROR_SHAPES: RegExp[] = [
  // JS/Java stack frame. Every quantifier after the anchor is bounded: the
  // unbounded form backtracked O(n^2) on an adversarial `at aaaa...` line with
  // no `:<digit>`, and this runs per raw log line, client-side.
  /^\s*at\s+[\w.$<>[\]]{1,200}\s{0,8}\(?[^\n]{0,256}:\d+(?::\d+)?\)?/,
  /^\s*File\s+"[^"\n]{0,256}",\s+line\s+\d+/, // Python traceback frame
  /^\s*Caused by:\s/, // Java
  /^\s*\.{3}\s+\d+\s+more\s*$/, // Java's elided-frames marker
  /^goroutine\s+\d+\s+\[/, // Go panic dump
  /\bTraceback \(most recent call last\)/,
  /(?:^|[\s([])[A-Za-z_][\w.$]*(?:Error|Exception)\s*:/, // TypeError: / java.io.IOException:
  /\b(?:uncaught|unhandled)\s+(?:exception|error|rejection|promise)/i,
  /\bSegmentation fault\b|\bcore dumped\b|\bOOMKilled\b/i,
  /^\s*Killed\s*$/,
  /\bsignal:\s*killed\b/i,
  /\bexit(?:ed with)?\s+(?:status|code)\s+[1-9]\d*\b/i,
  /\bexit\s+code\s+[1-9]\d*\b/i,
  // errno / a POSIX error constant. Restricted to a NON-ZERO errno and to the
  // `E[A-Z]+` form of `code`, because the old `code\s*[:=]\s*\d+` turned every
  // `code: 200` into an error.
  /\berrno\s*[:=]\s*-?[1-9]\d*\b/i,
  /\bcode\s*[:=]\s*['"]?(E[A-Z]{2,})\b/,
];

/** Tier 4 - success is claimed, not inferred. A completion marker the producer
 *  printed on purpose, and nothing that merely sounds healthy. */
const SUCCESS_SHAPES: RegExp[] = [
  /\[\s*(?:ok|success|succeeded|done|pass(?:ed)?)\s*\]/i,
  /[✓✔√✅]/,
  /\bcompiled successfully\b/i,
  /\bbuild succeeded\b/i,
  /\bready in\s+\d/i,
];

/** Warn shapes that are not a level tag. Deprecation notices are the whole list:
 *  the word appears in deprecation notices and nowhere else. */
const WARN_SHAPES: RegExp[] = [/\bdeprecat(?:ed|ion|ing)\b/i, /[‼⚠]/];

/**
 * An HTTP method somewhere on the line followed by a 3-digit token - the shape of
 * every access log, and the ONLY context in which a bare number is read as a
 * status.
 */
const ACCESS_LOG =
  /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\b[^\n]{0,512}?\s(\d{3})(?=\s|$)/;

/** A status carried in a NAMED field is structured evidence on its own, so it
 *  needs no method: `"status":500`, `status_code=404`, Traefik's DownstreamStatus. */
const NAMED_STATUS =
  /["']?(?:status|statuscode|status_code|http_status|downstreamstatus|response_code)["']?\s*[:=]\s*["']?([1-5]\d{2})\b/i;

/** Tier 3 - a status code, mapped conservatively. 2xx/3xx stay INFO rather than
 *  going green: a busy access log is thousands of 200s, and a pane that is a
 *  wall of green says as little as one that is a wall of grey. */
function levelFromStatus(m: string): LogLevel | null {
  const code = Number(NAMED_STATUS.exec(m)?.[1] ?? ACCESS_LOG.exec(m)?.[1]);
  if (!code) return null;
  if (code >= 500) return "error";
  if (code >= 400) return "warn";
  return "info";
}

/**
 * Classify a single raw log line. Pass the PLAIN line (ANSI already stripped) -
 * escape codes would otherwise leak into the patterns, e.g. a `[0m` reset
 * masquerading as a `[…]`-bracketed tag.
 */
export function detectLogLevel(message: string): LogLevel {
  const declared = declaredLevel(message);
  if (declared) return declared;

  for (const re of KNOWN_ERROR_SHAPES) if (re.test(message)) return "error";

  const byStatus = levelFromStatus(message);
  if (byStatus) return byStatus;

  for (const re of WARN_SHAPES) if (re.test(message)) return "warn";
  for (const re of SUCCESS_SHAPES) if (re.test(message)) return "success";

  return "info";
}

/**
 * Is this line the CONTINUATION of the one above it rather than a record of its
 * own?
 */
export function isLogContinuation(line: string): boolean {
  return (
    /^(?:\s{2,}|\t)/.test(line) ||
    /^\s*at\s/.test(line) ||
    /^\s*File\s+"/.test(line) ||
    /^\s*Caused by:/.test(line) ||
    /^\s*\.{3}\s+\d+\s+more/.test(line) ||
    /^goroutine\s+\d+\s+\[/.test(line) ||
    /^[}\])]/.test(line)
  );
}

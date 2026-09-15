import type { LogLevel } from "./types/deployment";

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

function levelFromNumber(n: number): LogLevel | null {
  if (n >= 10) {
    if (n >= 50) return "error";
    if (n >= 40) return "warn";
    if (n >= 30) return "info";
    return "debug";
  }
  if (n <= 7) {
    if (n <= 3) return "error";
    if (n === 4) return "warn";
    if (n <= 6) return "info";
    return "debug";
  }
  return null;
}

const LEVEL_KEY = "level|severity|levelname|loglevel|log\\.level|lvl";

const JSON_LEVEL = new RegExp(
  `"(?:${LEVEL_KEY})"\\s*:\\s*"([A-Za-z]{3,11})"`,
  "i",
);

const JSON_LEVEL_NUM = new RegExp(
  `"(?:${LEVEL_KEY})"\\s*:\\s*(\\d{1,2})(?![\\d.])`,
  "i",
);

const LOGFMT_LEVEL = new RegExp(
  `(?:^|\\s)(?:${LEVEL_KEY})\\s*=\\s*"?([A-Za-z]{3,11})"?(?=[\\s,;}\\])]|$)`,
  "i",
);

const BRACKET_WORDS = /\[\s*([A-Za-z]{3,11})\s*\]/g;

const TAGGED_WORDS = /(?:^|[\s\]|>])([A-Za-z]{3,11})\s*:(?!\/)/g;

const GLOG = /^([EWIF])\d{4}\s+\d{2}:\d{2}:\d{2}/;
const GLOG_LEVEL: Record<string, LogLevel> = {
  E: "error",
  F: "error",
  W: "warn",
  I: "info",
};

const COLUMN_LEVEL =
  /(?:^|\s)(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE|NOTICE)(?=\s)/;
const COLUMN_LEVEL_WINDOW = 64;

const SYSLOG_PRI = /^<(\d{1,3})>/;

const NPM_PREFIX = /^\s*(?:npm|pnpm|yarn)\s+(ERR!|WARN|warning|notice)(?=\s|$)/;

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

function firstLevelWord(m: string, re: RegExp): LogLevel | null {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(m)) !== null) {
    const level = levelWord(match[1]);
    if (level) return level;
  }
  return null;
}

const KNOWN_ERROR_SHAPES: RegExp[] = [
  /^\s*at\s+[\w.$<>[\]]{1,200}\s{0,8}\(?[^\n]{0,256}:\d+(?::\d+)?\)?/,
  /^\s*File\s+"[^"\n]{0,256}",\s+line\s+\d+/,
  /^\s*Caused by:\s/,
  /^\s*\.{3}\s+\d+\s+more\s*$/,
  /^goroutine\s+\d+\s+\[/,
  /\bTraceback \(most recent call last\)/,
  /(?:^|[\s([])[A-Za-z_][\w.$]*(?:Error|Exception)\s*:/,
  /\b(?:uncaught|unhandled)\s+(?:exception|error|rejection|promise)/i,
  /\bSegmentation fault\b|\bcore dumped\b|\bOOMKilled\b/i,
  /^\s*Killed\s*$/,
  /\bsignal:\s*killed\b/i,
  /\bexit(?:ed with)?\s+(?:status|code)\s+[1-9]\d*\b/i,
  /\bexit\s+code\s+[1-9]\d*\b/i,
  /\berrno\s*[:=]\s*-?[1-9]\d*\b/i,
  /\bcode\s*[:=]\s*['"]?(E[A-Z]{2,})\b/,
];

const SUCCESS_SHAPES: RegExp[] = [
  /\[\s*(?:ok|success|succeeded|done|pass(?:ed)?)\s*\]/i,
  /[✓✔√✅]/,
  /\bcompiled successfully\b/i,
  /\bbuild succeeded\b/i,
  /\bready in\s+\d/i,
];

const WARN_SHAPES: RegExp[] = [
  /\bdeprecat(?:ed|ion|ing)\b/i,
  /[‼⚠]/,
  /\b[1-9]\d*\s+warnings?\s+found\b/i,
];

const ACCESS_LOG =
  /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\b[^\n]{0,512}?\s(\d{3})(?=\s|$)/;

const NAMED_STATUS =
  /["']?(?:status|statuscode|status_code|http_status|downstreamstatus|response_code)["']?\s*[:=]\s*["']?([1-5]\d{2})\b/i;

function levelFromStatus(m: string): LogLevel | null {
  const code = Number(NAMED_STATUS.exec(m)?.[1] ?? ACCESS_LOG.exec(m)?.[1]);
  if (!code) return null;
  if (code >= 500) return "error";
  if (code >= 400) return "warn";
  return "info";
}

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

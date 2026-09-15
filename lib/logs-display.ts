export const LOGS_DISPLAY_KEY = "deplo:logs-display";

export const MIN_LOG_SIZE = 11;
export const MAX_LOG_SIZE = 20;

export interface LogsDisplay {
  size: number;
  leading: number;
}

export const LOGS_DISPLAY_DEFAULTS: LogsDisplay = { size: 13, leading: 1.625 };

export const LOG_LEADINGS = [
  { value: 1.35, label: "Tight" },
  { value: 1.625, label: "Normal" },
  { value: 2, label: "Loose" },
];

export const clampLogSize = (n: number) =>
  Math.min(MAX_LOG_SIZE, Math.max(MIN_LOG_SIZE, Math.round(n)));

export function parseLogsDisplay(raw: string | null): LogsDisplay {
  if (!raw) return LOGS_DISPLAY_DEFAULTS;
  try {
    const saved = JSON.parse(raw) as Partial<LogsDisplay>;
    const size = Number(saved?.size);
    return {
      size: Number.isFinite(size)
        ? clampLogSize(size)
        : LOGS_DISPLAY_DEFAULTS.size,
      leading: LOG_LEADINGS.some((l) => l.value === saved?.leading)
        ? saved.leading!
        : LOGS_DISPLAY_DEFAULTS.leading,
    };
  } catch {
    return LOGS_DISPLAY_DEFAULTS;
  }
}

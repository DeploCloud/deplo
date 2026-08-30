// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How big a log pane reads. Held per browser (localStorage), not per app and not
 * on the account: it answers "can I read this screen", which belongs to the
 * screen. The UI is components/shared/logs-display.tsx.
 */

export const LOGS_DISPLAY_KEY = "deplo:logs-display";

export const MIN_LOG_SIZE = 11;
export const MAX_LOG_SIZE = 20;

export interface LogsDisplay {
  /** Pixels. Every other box in a row is a multiple of it. */
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

/**
 * Read what the browser stored. Every field is re-validated: the value is
 * user-writable, and a stale or hand-edited one must not reach the CSS.
 */
export function parseLogsDisplay(raw: string | null): LogsDisplay {
  if (!raw) return LOGS_DISPLAY_DEFAULTS;
  try {
    const saved = JSON.parse(raw) as Partial<LogsDisplay>;
    const size = Number(saved?.size);
    return {
      size: Number.isFinite(size)
        ? clampLogSize(size)
        : LOGS_DISPLAY_DEFAULTS.size,
      // An unknown leading is one we no longer offer: fall back rather than let
      // it through, so the three buttons always match what is applied.
      leading: LOG_LEADINGS.some((l) => l.value === saved?.leading)
        ? saved.leading!
        : LOGS_DISPLAY_DEFAULTS.leading,
    };
  } catch {
    return LOGS_DISPLAY_DEFAULTS;
  }
}

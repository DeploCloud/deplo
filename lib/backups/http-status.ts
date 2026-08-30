// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The HTTP status that matches what the backup data layer refused.
 */
export function statusForBackupError(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/permission|not allowed|can't access|cannot access/i.test(message))
    return 403;
  if (/already running/i.test(message)) return 409;
  return 400;
}

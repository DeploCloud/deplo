export function statusForBackupError(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/permission|not allowed|can't access|cannot access/i.test(message))
    return 403;
  if (/already running/i.test(message)) return 409;
  return 400;
}

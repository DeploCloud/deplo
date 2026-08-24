/**
 * The HTTP status that matches what the backup data layer refused.
 *
 * Matched on the message because that layer throws plain Errors - every gate in
 * `lib/data` does, and giving backups their own error taxonomy for two routes
 * would be the wrong place to start one. The default is 400, so an unrecognised
 * message is no worse than it was.
 *
 * Shared by the two REST exceptions that act on artifacts (`download` and
 * `restore-upload`): a refusal must read the same to a browser, a proxy log and
 * a script whichever of the two produced it.
 */
export function statusForBackupError(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/permission|not allowed|can't access|cannot access/i.test(message))
    return 403;
  if (/already running/i.test(message)) return 409;
  return 400;
}

/** A value the user set, plus what the server was serving when they set it. */
export type ValueOverride<T> = { base: T; value: T } | null;

// settleOverride retires the override once the server's value moves off its base.
export function settleOverride<T>(
  override: ValueOverride<T>,
  serverValue: T,
): ValueOverride<T> {
  if (!override) return null;
  return Object.is(override.base, serverValue) ? override : null;
}

/** What to render: the override while it stands, the server's value otherwise. */
export function overrideValue<T>(
  override: ValueOverride<T>,
  serverValue: T,
): T {
  return override ? override.value : serverValue;
}

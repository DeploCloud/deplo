export type ValueOverride<T> = { base: T; value: T } | null;

export function settleOverride<T>(
  override: ValueOverride<T>,
  serverValue: T,
): ValueOverride<T> {
  if (!override) return null;
  return Object.is(override.base, serverValue) ? override : null;
}

export function overrideValue<T>(
  override: ValueOverride<T>,
  serverValue: T,
): T {
  return override ? override.value : serverValue;
}

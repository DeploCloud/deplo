/**
 * The bookkeeping behind an optimistically changed VALUE: a name the user just
 * typed, a switch they just flipped, a colour they just picked.
 *
 * Sibling of `optimistic-remove.ts` and the same division of labour: the rules
 * live here, free of React and testable without a renderer; the state lives in
 * `components/shared/use-optimistic-value.ts`.
 *
 * The rule is one sentence: an override stands until the server SAYS SOMETHING
 * ELSE. Not until the mutation resolves (the RSC refresh carrying the new value
 * lands a beat later, and dropping the override in between paints the old name
 * for a frame), and not on a timer — the prop itself is the signal.
 */

/** A value the user set, plus what the server was serving when they set it. */
export type ValueOverride<T> = { base: T; value: T } | null;

/**
 * Retire the override once the server's value has moved off the base it was
 * taken against — that move IS the refresh landing (or somebody else changing
 * the same thing in another tab).
 *
 * A successful mutation that leaves the served value UNCHANGED (renaming
 * something to the name it already had, flipping a switch back) therefore keeps
 * its override forever, which is correct: the override and the server agree, so
 * nothing on screen is stale, and the first genuine change from anywhere retires
 * it.
 *
 * Returns the SAME object when it stands — the caller stores this in React state
 * during render, and a fresh-but-equal object there would re-render forever.
 */
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

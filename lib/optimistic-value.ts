// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bookkeeping behind an optimistically changed VALUE: a name the user just
 * typed, a switch they just flipped, a colour they just picked.
 */

/** A value the user set, plus what the server was serving when they set it. */
export type ValueOverride<T> = { base: T; value: T } | null;

/**
 * Retire the override once the server's value has moved off the base it was taken
 * against - that move IS the refresh landing (or somebody else changing the same
 * thing in another tab).
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

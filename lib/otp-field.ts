/**
 * The edit model behind the split one-time-code input
 * (`components/ui/otp-input.tsx`), where each digit gets its own box.
 *
 * Pure logic with no React import so `bun run test` can drive every key and
 * paste path directly — the same split `lib/exec-line-editor.ts` uses. What
 * makes a split field fiddly is not the rendering, it is that six boxes have to
 * behave like ONE cursor: typing advances, backspace retreats, a pasted code
 * fills everything, and no box is reachable past the first empty one.
 *
 * The model is DENSE: `value` holds 0..length characters, always packed from the
 * left, and the caret is implied by its length. A sparse model (each box owning
 * its own slot, gaps allowed) is where the real bugs live — "1_3_5_" is a state
 * no user meant to create and every consumer then has to defend against. Making
 * the gap unrepresentable is cheaper than validating it away.
 */

/** Where the caret sits for a given value: the first empty box, clamped. */
export function caretFor(value: string, length: number): number {
  return Math.min(value.length, length - 1);
}

/** True once every box is filled. */
export function isComplete(value: string, length: number): boolean {
  return value.length === length;
}

/** The result of any edit: the new value and where focus should land. */
export interface OtpEdit {
  value: string;
  caret: number;
}

/**
 * Clamp an index to the reachable range. A box after the first empty one is not
 * a legal place to be — clicking box 5 of an empty field puts you in box 1.
 */
function reachable(value: string, index: number, length: number): number {
  return Math.max(0, Math.min(index, value.length, length - 1));
}

/**
 * Type one character at `index`.
 *
 * Non-digits are dropped rather than rejected loudly: the field is numeric, and
 * a stray letter from a keyboard layout should be a no-op, not an error state.
 * Typing over a filled box REPLACES that digit (so a mistyped third digit is one
 * keystroke to fix), while typing at the end appends.
 */
export function typeDigit(
  value: string,
  index: number,
  char: string,
  length: number,
): OtpEdit {
  const digit = char.replace(/\D/g, "").slice(-1);
  if (!digit) return { value, caret: reachable(value, index, length) };
  const i = reachable(value, index, length);
  const next = (value.slice(0, i) + digit + value.slice(i + 1)).slice(0, length);
  return { value: next, caret: Math.min(i + 1, length - 1) };
}

/**
 * Backspace at `index`.
 *
 * On a filled box it removes that digit and closes the gap; at the end it
 * removes the last one. Either way the caret follows the deletion backwards,
 * which is what makes holding backspace clear the field.
 */
export function backspace(value: string, index: number, length: number): OtpEdit {
  const i = reachable(value, index, length);
  if (i < value.length)
    return { value: value.slice(0, i) + value.slice(i + 1), caret: i };
  if (value.length === 0) return { value, caret: 0 };
  return { value: value.slice(0, -1), caret: value.length - 1 };
}

/**
 * Paste at `index`, keeping only digits.
 *
 * Deliberately lenient about what it accepts: people paste `123 456`, `123-456`
 * and a code with a trailing newline out of a password manager, and all three
 * mean the same six digits. Overflow is truncated rather than refused.
 */
export function pasteDigits(
  value: string,
  index: number,
  text: string,
  length: number,
): OtpEdit {
  const digits = text.replace(/\D/g, "");
  if (!digits) return { value, caret: reachable(value, index, length) };
  const i = reachable(value, index, length);
  const next = (value.slice(0, i) + digits).slice(0, length);
  return { value: next, caret: caretFor(next, length) };
}

/**
 * One `input` event on a box, which is not always one keystroke.
 *
 * A password manager or a platform one-time-code autofill delivers the WHOLE
 * code as a single input event on the first box — no paste event is fired, so
 * `onPaste` never sees it, and `typeDigit` (which keeps the last digit, because
 * a box that already holds one reports "old+new") would throw away five of the
 * six digits and leave the user staring at a field holding just a "6".
 *
 * The discriminator is the box being EMPTY: more than one digit arriving where
 * nothing was is a fill, while two characters arriving on an occupied box is
 * somebody replacing a digit they already typed.
 */
export function typeOrFill(
  value: string,
  index: number,
  raw: string,
  boxIsEmpty: boolean,
  length: number,
): OtpEdit {
  const digits = raw.replace(/\D/g, "");
  return digits.length > 1 && boxIsEmpty
    ? pasteDigits(value, index, digits, length)
    : typeDigit(value, index, raw, length);
}

/** Move the caret one box, never past the first empty one. */
export function moveCaret(
  value: string,
  index: number,
  step: -1 | 1,
  length: number,
): number {
  return reachable(value, index + step, length);
}

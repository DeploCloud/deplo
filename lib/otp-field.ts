export function caretFor(value: string, length: number): number {
  return Math.min(value.length, length - 1);
}

export function isComplete(value: string, length: number): boolean {
  return value.length === length;
}

export interface OtpEdit {
  value: string;
  caret: number;
}

function reachable(value: string, index: number, length: number): number {
  return Math.max(0, Math.min(index, value.length, length - 1));
}

export function typeDigit(
  value: string,
  index: number,
  char: string,
  length: number,
): OtpEdit {
  const digit = char.replace(/\D/g, "").slice(-1);
  if (!digit) return { value, caret: reachable(value, index, length) };
  const i = reachable(value, index, length);
  const next = (value.slice(0, i) + digit + value.slice(i + 1)).slice(
    0,
    length,
  );
  return { value: next, caret: Math.min(i + 1, length - 1) };
}

export function backspace(
  value: string,
  index: number,
  length: number,
): OtpEdit {
  const i = reachable(value, index, length);
  if (i < value.length)
    return { value: value.slice(0, i) + value.slice(i + 1), caret: i };
  if (value.length === 0) return { value, caret: 0 };
  return { value: value.slice(0, -1), caret: value.length - 1 };
}

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

export function moveCaret(
  value: string,
  index: number,
  step: -1 | 1,
  length: number,
): number {
  return reachable(value, index + step, length);
}

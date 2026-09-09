/**
 * An archive picked somewhere other than the wizard (dropped on the Overview) and
 * handed to it across a client-side navigation. A `File` cannot ride a URL, so it
 * rides the module; a real page load clears it, and the wizard then shows an empty
 * drop zone rather than a filename with no bytes behind it.
 */
let pending: File | null = null;

export function setPendingArchive(file: File | null): void {
  pending = file;
}

/** Read it without consuming it, so a render stays pure. */
export function peekPendingArchive(): File | null {
  return pending;
}

/** Drop it once the wizard has it. A second mount must not inherit the same file. */
export function clearPendingArchive(): void {
  pending = null;
}

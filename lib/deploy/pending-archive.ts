// A `File` cannot ride a URL, so an archive dropped on the Overview rides the module; a real page load clears it.
let pending: File | null = null;

export function setPendingArchive(file: File | null): void {
  pending = file;
}

// Read it without consuming it, so a render stays pure.
export function peekPendingArchive(): File | null {
  return pending;
}

// Drop it once the wizard has it. A second mount must not inherit the same file.
export function clearPendingArchive(): void {
  pending = null;
}

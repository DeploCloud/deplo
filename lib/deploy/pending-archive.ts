let pending: File | null = null;

export function setPendingArchive(file: File | null): void {
  pending = file;
}

export function peekPendingArchive(): File | null {
  return pending;
}

export function clearPendingArchive(): void {
  pending = null;
}

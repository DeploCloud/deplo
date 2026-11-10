/** "App paused 2.1 s" for a backup row, or null when the App was not paused. */
export function heldLabel(heldMs: number | null | undefined): string | null {
  if (!heldMs || heldMs <= 0) return null;
  if (heldMs < 1000) return "App paused under 1 s";
  const s = Math.round(heldMs / 100) / 10;
  if (s < 60) return `App paused ${s} s`;
  const total = Math.round(s);
  return `App paused ${Math.floor(total / 60)} min ${total % 60} s`;
}

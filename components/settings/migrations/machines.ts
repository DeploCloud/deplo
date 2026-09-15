export function twinAt<
  M extends { sourceId: string; ipAddress: string | null },
>(machines: M[], sourceId: string, address: string): M | null {
  const a = address.trim().toLowerCase();
  if (!a) return null;
  return (
    machines.find(
      (m) => m.sourceId !== sourceId && m.ipAddress?.trim().toLowerCase() === a,
    ) ?? null
  );
}

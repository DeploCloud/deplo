/**
 * The machine of the list already sitting at a typed address, if any: a panel
 * behind a proxy is usually one of the hosts it lists under another name.
 */
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

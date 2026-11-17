export function clashingKeys(keys: string[], existing: string[]): string[] {
  const have = new Set(existing);
  return [...new Set(keys.map((k) => k.trim()))].filter((k) => have.has(k));
}

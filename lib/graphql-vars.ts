/**
 * A variable the document does not declare is DROPPED by the server, silently:
 * the call looks like it worked and half of what it asked for never happened.
 * A document and its call site that disagree is always a bug here, so it says so.
 */
export function assertVariablesDeclared(
  query: string,
  variables?: Record<string, unknown>,
): void {
  if (!variables) return;
  const header = query.slice(0, query.indexOf("{"));
  const declared = new Set(
    [...header.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]),
  );
  const undeclared = Object.keys(variables).filter((k) => !declared.has(k));
  if (undeclared.length === 0) return;
  throw new Error(
    `GraphQL document does not declare ${undeclared
      .map((v) => `$${v}`)
      .join(", ")} - the server would ignore it`,
  );
}

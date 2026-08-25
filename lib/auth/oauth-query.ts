/**
 * Rebuild the signed authorization query the consent page was handed.
 */
export function rebuildOauthQuery(
  params: Record<string, string | string[] | undefined>,
): string {
  return new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined
        ? []
        : Array.isArray(value)
          ? value.map((one) => [key, one] as [string, string])
          : [[key, value] as [string, string]],
    ),
  ).toString();
}

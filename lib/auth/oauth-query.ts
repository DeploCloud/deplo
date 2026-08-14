/**
 * Rebuild the signed authorization query the consent page was handed.
 *
 * The OAuth provider does not pass the authorization request through in a
 * session: it signs the whole query onto the consent page's URL and verifies
 * that signature when the consent is posted back. So the query has to make the
 * round trip **byte for byte**, and the page reads it through Next's
 * `searchParams`, which is not a string.
 *
 * The trap is repeated keys. The signature covers one `ba_param` entry per
 * signed parameter, so the query carries `ba_param` half a dozen times and Next
 * hands those back as an ARRAY. Keeping only the string-valued entries drops
 * every one of them, the signature stops matching, and the consent is refused —
 * with the browser sitting on a screen where Authorize appears to do nothing at
 * all. Lives here rather than inline in the page so a test can reach it.
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

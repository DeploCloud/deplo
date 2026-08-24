import {
  uniqueNamesGenerator,
  adjectives,
  animals,
} from "unique-names-generator";

/**
 * Regenerating a server-provided nip.io suggestion, in the BROWSER.
 *
 * The names themselves are minted server-side (`nipDomain` in lib/deploy/domains,
 * which is `server-only` because it reads this machine's interfaces). What a form
 * needs on top of that is a Generate button that keeps working without a round
 * trip, and that only ever changes the part which is free to change: the two
 * random words. The app label and the trailing hex IP are what make the host
 * resolve to the right server, so they are preserved exactly.
 */

/**
 * A server-provided suggestion has the shape
 * `<label>-<adjective>-<animal>-<hexip>.nip.io`. This peels off the label and the
 * trailing hex-IP suffix (both of which must stay fixed for the host to keep
 * resolving to the right server) so only the two random words get regenerated.
 * `.*` is greedy, so the label absorbs any hyphens in the slug and only the last
 * two `[a-z0-9]+` tokens before the hex IP are treated as the words.
 */
const NIP_SUGGESTION_RE = /^(.*)-[a-z0-9]+-[a-z0-9]+-([0-9a-f]{8}\.nip\.io)$/i;

/** A fresh `adjective-animal` pair (same generator the server uses), in the
 * browser, so every click yields new words with no round-trip. */
function freshWords(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: "-",
    length: 2,
  });
}

/**
 * Produce a brand-new zero-config nip.io host from a server suggestion by
 * swapping only its random words — the label and hex-IP suffix are preserved, so
 * the result still routes to the correct server. Each call is independent (no
 * limit, no caching), so a Generate button can be clicked indefinitely. Falls
 * back to the original suggestion if it doesn't match the expected shape.
 */
export function regenerateNipDomain(suggested: string): string {
  const m = NIP_SUGGESTION_RE.exec(suggested);
  if (!m) return suggested;
  const [, label, hexSuffix] = m;
  return `${label}-${freshWords()}-${hexSuffix}`;
}

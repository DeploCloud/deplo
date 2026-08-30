// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import {
  uniqueNamesGenerator,
  adjectives,
  animals,
} from "unique-names-generator";

/**
 * Regenerating a server-provided nip.io suggestion, in the BROWSER. The names
 * themselves are minted server-side (`nipDomain` in lib/deploy/domains, which is
 * `server-only` because it reads this machine's interfaces).
 */

/**
 * A server-provided suggestion has the shape
 * `<label>-<adjective>-<animal>-<hexip>.nip.io`.
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
 * Produce a brand-new zero-config nip.io host from a server suggestion by swapping
 * only its random words - the label and hex-IP suffix are preserved, so the result
 * still routes to the correct server.
 */
export function regenerateNipDomain(suggested: string): string {
  const m = NIP_SUGGESTION_RE.exec(suggested);
  if (!m) return suggested;
  const [, label, hexSuffix] = m;
  return `${label}-${freshWords()}-${hexSuffix}`;
}

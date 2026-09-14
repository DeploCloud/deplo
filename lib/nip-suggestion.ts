import { friendlyWords } from "./friendly-words";

const NIP_SUGGESTION_RE = /^(.*)-[a-z0-9]+-[a-z0-9]+-([0-9a-f]{8}\.nip\.io)$/i;

// The server minter (nipDomain, lib/deploy/domains) is server-only - it reads this machine's
// interfaces - so the words are re-rolled here in the browser, not imported and not fetched.
function freshWords(): string {
  return friendlyWords();
}

// regenerateNipDomain swaps a suggestion's random words, keeping its label and hex-IP suffix.
export function regenerateNipDomain(suggested: string): string {
  const m = NIP_SUGGESTION_RE.exec(suggested);
  if (!m) return suggested;
  const [, label, hexSuffix] = m;
  return `${label}-${freshWords()}-${hexSuffix}`;
}

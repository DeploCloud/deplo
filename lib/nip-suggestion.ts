import { friendlyWords } from "./friendly-words";

const NIP_SUGGESTION_RE = /^(.*)-[a-z0-9]+-[a-z0-9]+-([0-9a-f]{8}\.nip\.io)$/i;

function freshWords(): string {
  return friendlyWords();
}

export function regenerateNipDomain(suggested: string): string {
  const m = NIP_SUGGESTION_RE.exec(suggested);
  if (!m) return suggested;
  const [, label, hexSuffix] = m;
  return `${label}-${freshWords()}-${hexSuffix}`;
}

import { friendlyWord } from "./friendly-words";
import { wildcardSuffixGroup } from "./wildcard-dns";

// <label>-<word>-<hexip>.<zone>: only the word is worth rolling again.
const AUTO_DOMAIN_RE = new RegExp(
  `^(.*)-[a-z0-9]+-([0-9a-f]{8}\\.${wildcardSuffixGroup()})$`,
  "i",
);

export function regenerateAutoDomain(
  suggested: string,
  current = suggested,
): string {
  const m = AUTO_DOMAIN_RE.exec(suggested);
  if (!m) return suggested;
  const [, label, hexSuffix] = m;
  const previousWord = AUTO_DOMAIN_RE.test(current)
    ? current.match(/-([a-z0-9]+)-[0-9a-f]{8}\./i)?.[1]?.toLowerCase()
    : undefined;
  return `${label}-${friendlyWord(previousWord)}-${hexSuffix}`;
}

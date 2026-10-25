import { AdvancedSection } from "@/components/apps/wizard/advanced-section";
import { LEVEL_META } from "./security-level";
import type { Update } from "./types";

// The expert's view: every advisory behind the updates, with its ids and score.
export function AdvisoriesTable({ updates }: { updates: Update[] }) {
  if (updates.length === 0) return null;
  return (
    <AdvancedSection summary={`${updates.length} advisories`}>
      <ul className="space-y-1.5 text-xs">
        {updates.map((u) => (
          <li
            key={`${u.service}:${u.vulnId}:${u.packageName}:${u.installedVersion}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
          >
            <a
              href={u.osvUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline-offset-2 hover:underline"
            >
              {u.vulnId}
            </a>
            {u.cve && u.cve !== u.vulnId ? (
              <span className="font-mono text-muted-foreground">{u.cve}</span>
            ) : null}
            <span className="text-muted-foreground">
              {u.packageName} {u.installedVersion}
              {u.cvss != null ? ` · CVSS ${u.cvss.toFixed(1)}` : ""}
              {u.level === "exploited" ? " · KEV" : ""} ·{" "}
              {LEVEL_META[u.level].label}
            </span>
          </li>
        ))}
      </ul>
    </AdvancedSection>
  );
}

import { packagesOf } from "@/lib/security-updates/group";
import { epssLabel } from "./fix-line";
import { LEVEL_META } from "./security-level";
import type { Update } from "./types";

// Scores and the advisory's own summary, which often names the condition it needs.
export function AdvisoryContext({ u }: { u: Update }) {
  const epss = epssLabel(u.epss);
  const scores = [u.cvss != null ? `CVSS ${u.cvss.toFixed(1)}` : null, epss]
    .filter(Boolean)
    .join(" · ");
  if (!scores && !u.summary) return null;
  return (
    <p className="truncate text-xs text-muted-foreground" title={u.summary}>
      {scores}
      {scores && u.summary ? " · " : ""}
      {u.summary}
    </p>
  );
}

// One advisory: its id opens it on osv.dev, with its level, scores and summary.
function AdvisoryLine({ u }: { u: Update }) {
  return (
    <li className="min-w-0 space-y-0.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <a
          href={u.osvUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono underline-offset-2 hover:underline"
        >
          {u.vulnId}
        </a>
        {u.cve && u.cve !== u.vulnId ? (
          <span className="font-mono text-muted-foreground">{u.cve}</span>
        ) : null}
        <span className="text-muted-foreground">
          {LEVEL_META[u.level].label}
        </span>
      </p>
      <AdvisoryContext u={u} />
    </li>
  );
}

// Every advisory behind one update; an image's are grouped by the package they hit.
export function AdvisoryList({
  updates,
  byPackage,
}: {
  updates: Update[];
  byPackage: boolean;
}) {
  if (!byPackage)
    return (
      <ul className="space-y-1.5 text-xs">
        {updates.map((u) => (
          <AdvisoryLine key={u.vulnId} u={u} />
        ))}
      </ul>
    );
  return (
    <div className="space-y-3 text-xs">
      {packagesOf(updates).map((p) => (
        <div key={p.key} className="space-y-1.5">
          <p className="font-mono text-muted-foreground">
            {p.packageName} {p.installedVersion}
          </p>
          <ul className="space-y-1.5 border-l border-border pl-3">
            {p.items.map((u) => (
              <AdvisoryLine key={u.vulnId} u={u} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

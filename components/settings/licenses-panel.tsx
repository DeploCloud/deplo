"use client";

import * as React from "react";
import { Code, Scale } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { countBy } from "@/components/shared/facet-filtering";
import { FilterFacet, useUrlFacets } from "@/components/shared/filter-facet";
import { ListToolbar } from "@/components/shared/list-toolbar";
import { GitHubIcon, NpmIcon } from "@/components/shared/brand-icons";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** One package, as scripts/third-party-notices.mjs writes it. */
export interface Notice {
  name: string;
  version: string;
  license: string;
  source: string;
  github: string | null;
  text: string;
}

const FACETS = ["license"] as const;

export function LicensesPanel({ notices }: { notices: Notice[] }) {
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = useUrlFacets(FACETS);
  const [selected, setSelected] = React.useState<Notice | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const counts = React.useMemo(
    () => countBy(notices, (n) => n.license),
    [notices],
  );
  const options = React.useMemo(
    () =>
      Object.keys(counts)
        .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
        .map((value) => ({ value, label: value })),
    [counts],
  );

  const q = query.trim().toLowerCase();
  const shown = notices.filter(
    (n) =>
      n.name.toLowerCase().includes(q) &&
      (picked.license.length === 0 || picked.license.includes(n.license)),
  );

  function open(n: Notice) {
    setSelected(n);
    setSheetOpen(true);
  }

  if (notices.length === 0) {
    return (
      <EmptyState
        icon={Scale}
        title="No packages listed"
        description="This build of Deplo carries no license list."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ListToolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search packages"
        filters={
          <FilterFacet
            id="license"
            label="License"
            allLabel="Any license"
            icon={Scale}
            options={options}
            counts={counts}
            values={picked.license}
            onChange={(v) => setPicked("license", v)}
          />
        }
      />

      {shown.length === 0 ? (
        <EmptyState
          icon={Scale}
          title="No matching packages"
          description="No package matches the current search and filter."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Package</TableHead>
                <TableHead className="hidden sm:table-cell">Version</TableHead>
                <TableHead>License</TableHead>
                <TableHead className="hidden text-right sm:table-cell">
                  Source
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((n) => (
                <TableRow
                  key={`${n.name}@${n.version}`}
                  className="cursor-pointer"
                  onClick={() => open(n)}
                >
                  <TableCell className="min-w-40">
                    <button
                      type="button"
                      className="cursor-pointer text-left font-medium break-words"
                    >
                      <Breakable name={n.name} />
                    </button>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                    {n.version}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="max-w-48">
                      <span className="min-w-0 truncate">{n.license}</span>
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="flex justify-end gap-1">
                      <SourceLinks notice={n} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 sm:w-2xl sm:max-w-[90vw]"
        >
          {selected && (
            <>
              <div className="space-y-1 border-b border-border p-4 pr-12">
                <SheetTitle className="break-all">{selected.name}</SheetTitle>
                <SheetDescription>
                  <span className="font-mono">{selected.version}</span>
                  {" · "}
                  {selected.license}
                </SheetDescription>
                <div className="flex gap-1 pt-2">
                  <SourceLinks notice={selected} labelled />
                </div>
              </div>
              <pre className="m-4 flex-1 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs break-words whitespace-pre-wrap">
                {selected.text ||
                  "No license file ships with this package; its source carries the license."}
              </pre>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// A scoped name may wrap after its scope, never inside a word.
function Breakable({ name }: { name: string }) {
  const slash = name.indexOf("/");
  if (slash < 0) return name;
  return (
    <>
      {name.slice(0, slash + 1)}
      <wbr />
      {name.slice(slash + 1)}
    </>
  );
}

function SourceLinks({
  notice,
  labelled,
}: {
  notice: Notice;
  labelled?: boolean;
}) {
  const links = [
    notice.github
      ? { href: notice.github, label: "GitHub", icon: GitHubIcon }
      : /^https?:\/\//.test(notice.source)
        ? { href: notice.source, label: "Source", icon: Code }
        : null,
    {
      href: `https://www.npmjs.com/package/${notice.name}/v/${notice.version}`,
      label: "npm",
      icon: NpmIcon,
    },
  ].filter((l) => l !== null);
  return links.map(({ href, label, icon: Icon }) => (
    <a
      key={label}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={labelled ? undefined : label}
      title={labelled ? undefined : label}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1.5 rounded-md p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon className="size-4" />
      {labelled && label}
    </a>
  ));
}

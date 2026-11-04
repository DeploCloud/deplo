"use client";

import * as React from "react";
import { Code, Scale } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { countBy } from "@/components/shared/facet-filtering";
import { FilterFacet, useUrlFacets } from "@/components/shared/filter-facet";
import { ListToolbar } from "@/components/shared/list-toolbar";
import { GitHubIcon, NpmIcon } from "@/components/shared/brand-icons";
import { Badge } from "@/components/ui/badge";
import { Bone } from "@/components/ui/skeleton";
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

function LicensesToolbar({
  query,
  onQuery,
  options,
  counts,
  values,
  onChange,
}: {
  query: string;
  onQuery: (v: string) => void;
  options: { value: string; label: string }[];
  counts: Record<string, number>;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <ListToolbar
      query={query}
      onQuery={onQuery}
      placeholder="Search packages"
      filters={
        <FilterFacet
          id="license"
          label="License"
          allLabel="Any license"
          icon={Scale}
          options={options}
          counts={counts}
          values={values}
          onChange={onChange}
        />
      }
    />
  );
}

function LicensesHead() {
  return (
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
  );
}

// One option, so the facet draws as it will once loaded, not as an empty one.
const PLACEHOLDER_OPTIONS = [{ value: "", label: "" }];
const SKELETON_PACKAGES = [
  "@scope/package",
  "package-name",
  "a-longer-package",
];

export function LicensesPanelSkeleton() {
  return (
    <div className="space-y-4">
      <LicensesToolbar
        query=""
        onQuery={() => {}}
        options={PLACEHOLDER_OPTIONS}
        counts={{}}
        values={[]}
        onChange={() => {}}
      />
      <div className="overflow-x-auto rounded-xl border border-border">
        <Table>
          <LicensesHead />
          <TableBody>
            {SKELETON_PACKAGES.map((name) => (
              <TableRow key={name}>
                <TableCell className="min-w-40">
                  <span className="font-medium">
                    <Bone>{name}</Bone>
                  </span>
                </TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                  <Bone>1.0.0</Bone>
                </TableCell>
                <TableCell>
                  <Bone box>
                    <Badge variant="secondary">MIT</Badge>
                  </Bone>
                </TableCell>
                <TableCell className="hidden sm:table-cell" />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

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
      <LicensesToolbar
        query={query}
        onQuery={setQuery}
        options={options}
        counts={counts}
        values={picked.license}
        onChange={(v) => setPicked("license", v)}
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
            <LicensesHead />
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
                      className="cursor-pointer text-left font-medium"
                    >
                      {n.name}
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
          className="flex w-full flex-col gap-0 md:w-2xl md:max-w-[90vw]"
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

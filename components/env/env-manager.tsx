"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import {
  EnvBulkSelection,
  EnvSelectAll,
} from "@/components/env/env-bulk-selection";
import {
  standaloneBulkItem,
  sharedBulkItem,
  unlinkBulkItem,
} from "@/components/env/env-bulk-items";
import { EnvGraphic } from "@/components/env/env-graphic";
import { EnvList } from "@/components/env/env-list";
import {
  EnvRowSkeleton,
  PendingRow,
  PLACEHOLDER_FACET_ROWS,
  PLACEHOLDER_KEYS,
  SharedRow,
  StandaloneRow,
  rowKey,
  type EnvRow,
} from "@/components/env/env-manager-rows";
import { EnvVarDialog } from "@/components/env/env-var-dialog";
import { EnvAddButton, type AddKind } from "@/components/env/env-add-button";
import { EnvDraftRows } from "@/components/env/env-drafts";
import {
  hasContent,
  newDraft,
  type Draft,
  type KnownVar,
} from "@/components/env/env-drafts-model";
import {
  savedToast,
  type AutoLinked,
} from "@/components/env/env-var-edit-form";
import { EnvFilters } from "@/components/env/env-filters/env-filters-toolbar";
import {
  editorFacet,
  sourceFacet,
  typeFacet,
  updatedFacet,
} from "@/components/env/env-filters/facets";
import { useEnvFilters } from "@/components/env/env-filters/use-env-filters";
import { gqlAction } from "@/lib/graphql-client";
import type { EnvVarDTO } from "@/lib/types/env";
import type { EnvExampleKeyDTO } from "@/lib/data/env-example";
import type { AppSharedVarDTO } from "@/lib/data/shared-vars/app-view";
import type { SharedVarDTO } from "@/lib/data/shared-vars/team-view";
import type { TeamEnvironment } from "@/lib/data/environments";
import type {
  AppRef,
  ProjectRef,
  TeamRef,
} from "@/components/env/shared-var-wizard/types";

export function EnvManager({
  appId,
  vars,
  pending = [],
  sharedVars,
  sharedVarDetails,
  canCreateShared,
  apps,
  projects,
  environments,
  teams,
  composeKeys = [],
  loading = false,
}: {
  appId: string;
  vars: EnvVarDTO[];
  pending?: EnvExampleKeyDTO[];
  sharedVars: AppSharedVarDTO[];
  sharedVarDetails: SharedVarDTO[];
  canCreateShared: boolean;
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  teams: TeamRef[];
  composeKeys?: string[];
  loading?: boolean;
}) {
  const [editing, setEditing] = React.useState<EnvVarDTO | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [opened, setOpened] = React.useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = React.useState<Draft[]>([]);
  const [addTab, setAddTab] = React.useState<AddKind | undefined>();
  const router = useRouter();

  const known = React.useMemo<KnownVar[]>(
    () => [
      ...vars.map((v) => ({ key: v.key, type: v.type })),
      ...pending.map((p) => ({
        key: p.key,
        type: "plain" as const,
        pending: true,
      })),
    ],
    [vars, pending],
  );
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(
    new Set(),
  );

  function dismiss(id: string) {
    setDismissed((prev) => new Set(prev).add(id));
    void (async () => {
      const res = await gqlAction(
        `mutation($id: String!) { dismissEnvExampleKey(id: $id) }`,
        { id },
      );
      if (res.ok) {
        router.refresh();
        return;
      }
      toast.error(res.error);
      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    })();
  }
  // A plain variable a draft would overwrite steps aside until the draft is saved or dropped.
  const drafted = new Set(drafts.map((d) => d.key.trim()).filter(Boolean));

  function addDraft() {
    setDrafts((prev) =>
      prev.some((d) => !hasContent(d)) ? prev : [newDraft(), ...prev],
    );
  }

  function saveDrafts(list: Draft[]) {
    const before = drafts;
    setDrafts([]);
    void (async () => {
      type AddResult = {
        added: number;
        skippedSecrets: number;
        autoLinked: AutoLinked[];
      };
      const res = await gqlAction<{ addEnv: AddResult }, AddResult>(
        `mutation($appId: String!, $entries: [EnvEntryInput!]!) {
          addEnv(appId: $appId, entries: $entries) {
            added skippedSecrets autoLinked { key database }
          }
        }`,
        {
          appId,
          entries: list.map((d) => ({
            key: d.key.trim(),
            value: d.value,
            note: d.note?.trim() || undefined,
            secret: d.secret || undefined,
          })),
        },
        (d) => d.addEnv,
      );
      if (!res.ok || res.data == null) {
        setDrafts(before);
        if (!res.ok) toast.error(res.error);
        return;
      }
      const { added, skippedSecrets, autoLinked } = res.data;
      savedToast(
        skippedSecrets > 0
          ? `Added ${added} variable(s), ${skippedSecrets} secret(s) skipped`
          : added === 1
            ? "Variable added"
            : `Added ${added} variables`,
        autoLinked,
      );
      router.refresh();
    })();
  }

  function toggleOpen(key: string) {
    setOpened((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  // The vars this app opted into (ADR-0012) plus the ones injected with no opt-in (ADR-0027).
  const appliedShared = React.useMemo(
    () => sharedVars.filter((v) => v.linked || v.autoInject),
    [sharedVars],
  );

  const detailsById = React.useMemo(
    () => new Map(sharedVarDetails.map((v) => [v.id, v] as const)),
    [sharedVarDetails],
  );

  const serverRows = React.useMemo<EnvRow[]>(
    () => [
      ...vars.map((v): EnvRow => ({ ...v, kind: "standalone" })),
      ...appliedShared.map((v): EnvRow => ({ ...v, kind: "shared" })),
    ],
    [vars, appliedShared],
  );

  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(serverRows, rowKey);

  const facets = React.useMemo(() => {
    const from = loading ? PLACEHOLDER_FACET_ROWS : rows;
    return [
      sourceFacet(from),
      typeFacet(from),
      editorFacet(from),
      updatedFacet<EnvRow>(),
    ];
  }, [rows, loading]);
  const {
    state: filters,
    setState: setFilters,
    shown: shownRows,
    counts,
  } = useEnvFilters(rows, facets);

  const bulkItems = shownRows.map((row) => {
    const id = rowKey(row);
    if (row.kind === "standalone") return standaloneBulkItem(row, id);
    const item = row.linked
      ? unlinkBulkItem(row, appId, id)
      : { ...row, id, scope: undefined };
    const full = detailsById.get(row.id);
    return {
      ...item,
      secretId: row.id,
      makeSecret:
        row.linked && canCreateShared && full
          ? sharedBulkItem(full).makeSecret
          : undefined,
    };
  });

  // A name to fill is no type, author or date a facet could match: facets hide it, search finds it.
  const faceted = Object.values(filters.facets).some((v) => v?.length);
  const needle = filters.q.trim().toLowerCase();
  const toFill = faceted
    ? []
    : pending.filter(
        (p) =>
          !dismissed.has(p.id) &&
          !drafted.has(p.key) &&
          p.key.toLowerCase().includes(needle),
      );

  const hasVars =
    loading || rows.length > 0 || drafts.length > 0 || pending.length > 0;
  const hasMatches =
    loading || shownRows.length > 0 || drafts.length > 0 || toFill.length > 0;
  const listed = shownRows.filter(
    (row) =>
      !(
        row.kind === "standalone" &&
        row.type === "plain" &&
        drafted.has(row.key)
      ),
  );

  const addButton = (size: "sm" | "default") => (
    <EnvAddButton
      size={size}
      disabled={loading}
      onAdd={addDraft}
      onMore={(kind) => {
        setEditing(null);
        setAddTab(kind);
        setAddOpen(true);
      }}
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Environment Variables</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Secret values are encrypted at rest and never shown again.
          </p>
        </div>
        {!hasVars && addButton("sm")}
      </div>

      {hasVars && (
        <EnvFilters
          state={filters}
          onChange={setFilters}
          facets={facets}
          counts={counts}
          actions={addButton("default")}
        />
      )}

      <EnvBulkSelection
        items={bulkItems}
        onRemoved={(ids) => {
          for (const id of ids) {
            const row = shownRows.find((row) => rowKey(row) === id);
            if (row?.kind === "standalone" || (row && !row.autoInject))
              remove(id);
          }
        }}
        removeConsequence="App variables are deleted. Shared variables are only unlinked here; automatically shared values still arrive."
      >
        {!hasVars ? (
          <EmptyState
            graphic={<EnvGraphic />}
            title="No environment variables"
            docs="env.overview"
            description="Add variables to configure your app - available during builds and at runtime."
          />
        ) : !hasMatches ? (
          <EmptyState
            icon={SearchX}
            title="No matching variables"
            description="No variable matches the current search and filters."
          />
        ) : (
          <EnvList select={<EnvSelectAll />}>
            {drafts.length > 0 && (
              <EnvDraftRows
                drafts={drafts}
                onChange={setDrafts}
                known={known}
                onSave={saveDrafts}
              />
            )}
            {toFill.map((item) => (
              <PendingRow
                key={item.id}
                item={item}
                appId={appId}
                open={opened.has(`pending:${item.id}`)}
                onToggle={() => toggleOpen(`pending:${item.id}`)}
                onDismiss={() => dismiss(item.id)}
              />
            ))}
            {loading &&
              PLACEHOLDER_KEYS.map((k) => (
                <EnvRowSkeleton key={k} envKey={k} />
              ))}
            {listed.map((row) =>
              row.kind === "standalone" ? (
                <StandaloneRow
                  key={rowKey(row)}
                  row={row}
                  open={opened.has(rowKey(row))}
                  onToggle={() => toggleOpen(rowKey(row))}
                  onEdit={() => {
                    setEditing(row);
                    setAddTab(undefined);
                    setAddOpen(true);
                  }}
                  onDelete={() => setDeleteId(row.id)}
                />
              ) : (
                <SharedRow
                  key={rowKey(row)}
                  row={row}
                  open={opened.has(rowKey(row))}
                  onToggle={() => toggleOpen(rowKey(row))}
                  appId={appId}
                  editable={detailsById.get(row.id)?.editable !== false}
                  manageable={
                    canCreateShared &&
                    detailsById.get(row.id)?.editable !== false
                  }
                  composeSetsIt={composeKeys.includes(row.key)}
                  onRemoved={() => remove(rowKey(row))}
                  onRestored={() => restore(rowKey(row))}
                />
              ),
            )}
          </EnvList>
        )}
      </EnvBulkSelection>

      <EnvVarDialog
        key={`${editing?.id ?? "new"}:${addTab ?? ""}`}
        tab={addTab}
        open={addOpen}
        onOpenChange={setAddOpen}
        appId={appId}
        editing={editing}
        existingKeys={vars.filter((v) => v.type === "plain").map((v) => v.key)}
        appKeys={vars.map((v) => v.key)}
        sharedVars={sharedVars}
        canCreateShared={canCreateShared}
        apps={apps}
        projects={projects}
        environments={environments}
        teams={teams}
      />
      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Delete variable?"
        description="This removes the variable. It will no longer be available to new deployments."
        confirmLabel="Delete"
        successMessage="Variable deleted"
        optimistic
        onConfirm={async () => {
          const id = deleteId!;
          const key = `standalone:${id}`;
          remove(key);
          const res = await gqlAction<{ deleteEnv: boolean }>(
            `mutation($id: String!) { deleteEnv(id: $id) }`,
            { id },
          );
          if (res.ok) router.refresh();
          else restore(key);
          return res;
        }}
      />
    </div>
  );
}

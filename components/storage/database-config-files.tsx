"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, TriangleAlert, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * The engine's own config files (Advanced): `postgresql.conf`, `my.cnf`,
 * `redis.conf`, a script under `/docker-entrypoint-initdb.d`. The third expert
 * override, next to image and command — and the one an engine's own
 * documentation assumes you have.
 *
 * It differs from its neighbours in one visible way, and the copy says so
 * twice: saving APPLIES. The image and command overrides change what the next
 * Redeploy builds; a config file changes what the running engine reads, so the
 * save writes the file and recreates the container.
 *
 * Every rule the server enforces is linted here too (relative file name,
 * absolute container path, nothing inside the data directory) so the form
 * refuses what the mutation would refuse, in the same words.
 */

/** ~40KB of CodeMirror, loaded only when a database actually has a file. */
const TextEditor = dynamic(
  () => import("@/components/apps/text-editor").then((m) => m.TextEditor),
  { ssr: false, loading: () => <EditorSkeleton /> },
);

/** How tall the box is before it scrolls — a config file, not a manuscript. */
const EDITOR_MIN_HEIGHT = 200;

/** A row while it is being edited: the saved shape plus a key React can hold on
 *  to, since two rows may briefly share an empty path. */
interface Row {
  key: string;
  filePath: string;
  content: string;
  mountPath: string;
}

let nextKey = 0;

function toRows(mounts: DatabaseDTO["mounts"]): Row[] {
  return mounts.map((m) => ({ key: `row-${nextKey++}`, ...m }));
}

/** What each engine documents as its config file, used as the placeholder pair
 *  so the commonest case is a matter of confirming what is already suggested. */
const SUGGESTION: Record<string, { filePath: string; mountPath: string }> = {
  postgres: { filePath: "postgresql.conf", mountPath: "/etc/postgresql.conf" },
  mysql: { filePath: "my.cnf", mountPath: "/etc/mysql/conf.d/my.cnf" },
  mariadb: { filePath: "my.cnf", mountPath: "/etc/mysql/conf.d/my.cnf" },
  mongodb: { filePath: "mongod.conf", mountPath: "/etc/mongod.conf" },
  redis: {
    filePath: "redis.conf",
    mountPath: "/usr/local/etc/redis/redis.conf",
  },
  clickhouse: {
    filePath: "config.xml",
    mountPath: "/etc/clickhouse-server/config.d/config.xml",
  },
};

/** The one refusal worth linting in the browser: the engine's data directory. */
function problemFor(row: Row, dataDir: string): string | null {
  const filePath = row.filePath.trim();
  const mountPath = row.mountPath.trim().replace(/\/+$/, "");
  if (!filePath) return "Give the file a name.";
  if (filePath.startsWith("/") || filePath.split("/").includes(".."))
    return 'The file name is relative, for example "postgresql.conf".';
  if (/[\s:]/.test(filePath))
    return 'A file name cannot contain spaces or ":".';
  if (!mountPath.startsWith("/") || mountPath.length < 2)
    return "The path in the container must be absolute, like /etc/postgresql.conf.";
  if (/[\s:]/.test(mountPath.slice(1)))
    return 'The path in the container cannot contain spaces or ":".';
  if (mountPath === dataDir || mountPath.startsWith(dataDir + "/"))
    return `${dataDir} holds the data itself. A file there is backed up with it and can stop the engine from starting.`;
  return null;
}

export function DatabaseConfigFiles({
  db,
  dataDir,
}: {
  db: DatabaseDTO;
  /** Where THIS engine keeps its data (`DB_DATA_DIRS`), passed in by the page:
   *  the constant lives next to the compose renderer, which is server-only, and
   *  a second copy of it here is exactly how the two would drift. */
  dataDir: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [rows, setRows] = React.useState<Row[]>(() => toRows(db.mounts));
  const suggestion = SUGGESTION[db.type] ?? {
    filePath: "engine.conf",
    mountPath: "/etc/engine.conf",
  };

  // What is stored right now. After a save `router.refresh()` re-renders with the
  // new props, so `dirty` clears itself without the form having to re-seed - the
  // same shape the Image & command card next door has.
  const saved = React.useMemo(() => JSON.stringify(db.mounts), [db.mounts]);

  const current = JSON.stringify(
    rows.map((r) => ({
      filePath: r.filePath.trim(),
      content: r.content,
      mountPath: r.mountPath.trim(),
    })),
  );
  const dirty = current !== saved;
  const problems = rows.map((r) => problemFor(r, dataDir));
  const blocked = problems.some(Boolean);

  const update = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function save() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $mounts: [DatabaseMountInput!]!) {
          setDatabaseMounts(id: $id, mounts: $mounts) { id }
        }`,
        {
          id: db.id,
          mounts: rows.map((r) => ({
            filePath: r.filePath.trim(),
            content: r.content,
            mountPath: r.mountPath.trim(),
          })),
        },
      );
      if (res.ok) {
        toast.success("Config files saved and applied");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Config files</CardTitle>
        <CardDescription>
          Files deplo writes next to the database and mounts into its container.
          Saving applies them: the container is{" "}
          <strong className="font-medium text-foreground">recreated</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No config files. The engine runs on its own defaults.
          </p>
        ) : (
          rows.map((row, i) => (
            <div
              key={row.key}
              className="space-y-3 rounded-lg border border-border p-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <FieldLabel
                    className="text-xs"
                    info="The file's name in this database's files directory on the server."
                  >
                    File name
                  </FieldLabel>
                  <Input
                    value={row.filePath}
                    onChange={(e) =>
                      update(row.key, { filePath: e.target.value })
                    }
                    placeholder={suggestion.filePath}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel
                    className="text-xs"
                    info={`Where the engine reads it inside the container. Anything under ${dataDir} is refused - that is the data itself.`}
                  >
                    Path in the container
                  </FieldLabel>
                  <Input
                    value={row.mountPath}
                    onChange={(e) =>
                      update(row.key, { mountPath: e.target.value })
                    }
                    placeholder={suggestion.mountPath}
                    className="font-mono text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <FieldLabel
                  className="text-xs"
                  info="What deplo writes into the file."
                >
                  What&apos;s in the file
                </FieldLabel>
                <TextEditor
                  value={row.content}
                  onChange={(content) => update(row.key, { content })}
                  minHeight={EDITOR_MIN_HEIGHT}
                />
              </div>

              {problems[i] && (
                <p className="flex items-start gap-1.5 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2 text-xs text-foreground">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
                  <span>{problems[i]}</span>
                </p>
              )}

              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setRows((rs) => rs.filter((r) => r.key !== row.key))
                  }
                >
                  <Trash2 className="size-3.5" />
                  Remove
                </Button>
              </div>
            </div>
          ))
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setRows((rs) => [
              ...rs,
              {
                key: `row-${nextKey++}`,
                filePath: "",
                content: "",
                mountPath: "",
              },
            ])
          }
        >
          <Plus className="size-3.5" />
          Add file
        </Button>
      </CardContent>
      <CardFooter className="justify-between">
        <DirtyHint dirty={dirty} />
        <Button onClick={save} disabled={pending || !dirty || blocked}>
          Save and apply
        </Button>
      </CardFooter>
    </Card>
  );
}

function EditorSkeleton() {
  return (
    <div
      className="animate-pulse rounded-lg border border-input bg-muted/30"
      style={{ minHeight: EDITOR_MIN_HEIGHT }}
      aria-hidden
    />
  );
}

"use client";

import * as React from "react";

import { Combobox } from "@/components/shared/combobox";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import type { DatabaseType } from "@/lib/types/database";

export interface BackupTargetOption {
  id: string;
  name: string;
  detail?: string | null;
  serverId?: string | null;
  logo?: string | null;
  type?: DatabaseType;
}

export function TargetCombobox({
  targets,
  value,
  onChange,
  kind,
  id,
  disabled,
}: {
  targets: BackupTargetOption[];
  value: string;
  onChange: (id: string) => void;
  kind: "app" | "database";
  id?: string;
  disabled?: boolean;
}) {
  const noun = kind === "app" ? "app" : "database";
  const mark = (t: BackupTargetOption) =>
    kind === "app" ? (
      <AppLogo logo={t.logo ?? null} size={20} />
    ) : (
      <DatabaseLogo
        type={t.type ?? "postgres"}
        logo={t.logo ?? null}
        size={20}
      />
    );
  return (
    <Combobox<BackupTargetOption>
      id={id}
      items={targets}
      value={value}
      onChange={onChange}
      getKey={(t) => t.id}
      matches={(t, q) =>
        t.name.toLowerCase().includes(q) ||
        (t.detail ?? "").toLowerCase().includes(q)
      }
      displayValue={(t) => t.name}
      placeholder={`Select ${kind === "app" ? "an app" : "a database"}`}
      searchPlaceholder={`Search ${noun}s`}
      emptyLabel={(hasItems) =>
        hasItems ? `No ${noun} matches that` : `No ${noun}s in this team yet`
      }
      disabled={disabled}
      renderLeading={mark}
      renderOption={(t) => (
        <span className="flex min-w-0 items-center gap-2">
          {mark(t)}
          <span className="min-w-0">
            <span className="block truncate text-sm">{t.name}</span>
            {t.detail && (
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {t.detail}
              </span>
            )}
          </span>
        </span>
      )}
    />
  );
}

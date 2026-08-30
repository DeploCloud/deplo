"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { Combobox } from "@/components/shared/combobox";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import type { DatabaseType } from "@/lib/types";

/** One thing a schedule can back up, as the picker needs it. */
export interface BackupTargetOption {
  id: string;
  name: string;
  /** The app's slug, or the database's engine - what tells two same-named ones
   *  apart, and the second thing typing searches. */
  detail?: string | null;
  serverId?: string | null;
  /** An app's logo, or a database's own; a database with none falls back to its
   *  engine's brand mark. */
  logo?: string | null;
  /** Databases only - picks the engine mark. */
  type?: DatabaseType;
}

/**
 * Pick the app or database a schedule backs up, by typing.
 */
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
  /** The thing's own icon - the one its card and its header already wear. */
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
      // The same mark the rows carry, kept in the field once one is picked.
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

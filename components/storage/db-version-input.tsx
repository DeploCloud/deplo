"use client";

import * as React from "react";
import {
  VersionCombobox,
  type VersionItem,
} from "@/components/apps/version-combobox";
import type { DatabaseType } from "@/lib/types/database";

// DbVersionInput - engine version autocomplete, synced live to Docker Hub via `/api/database-versions`.
export function DbVersionInput({
  engine,
  value,
  onChange,
  id,
  className,
}: {
  engine: DatabaseType;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  className?: string;
}) {
  // The combobox loads once per mount, so it is keyed on the engine (below) to re-fetch.
  const load = React.useCallback(async (): Promise<VersionItem[]> => {
    const r = await fetch(
      `/api/database-versions?engine=${encodeURIComponent(engine)}`,
    );
    const j = await r.json();
    const list = Array.isArray(j.versions) ? j.versions : [];
    return list.map((v: unknown) =>
      typeof v === "string"
        ? { value: v, label: v }
        : {
            value: String((v as VersionItem).value),
            label: String((v as VersionItem).label),
          },
    );
  }, [engine]);

  return (
    <VersionCombobox
      key={engine}
      value={value}
      onChange={onChange}
      load={load}
      placeholder="e.g. 18"
      id={id}
      className={className}
    />
  );
}

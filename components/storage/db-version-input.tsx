"use client";

import * as React from "react";
import {
  VersionCombobox,
  type VersionItem,
} from "@/components/apps/version-combobox";
import type { DatabaseType } from "@/lib/types";

/**
 * Database engine version input with an autocomplete dropdown synced live to
 * Docker Hub (via `/api/database-versions?engine=…`), so the list tracks new
 * engine releases automatically instead of a hardcoded set. Free text is always
 * allowed — the dropdown is a hint, and a user can pin any tag the image
 * publishes. The stored value is the bare version the DB image mapping appends
 * its suffix to (`postgres:<v>-alpine`, `mysql:<v>`, …).
 */
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
  // Re-fetch when the engine changes: the combobox loads once per mount, so key
  // it on the engine (below) to reset. `load` closes over the current engine.
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

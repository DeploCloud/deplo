"use client";

import * as React from "react";
import {
  VersionCombobox,
  type VersionItem,
} from "@/components/services/version-combobox";

/**
 * Railpack version input with an autocomplete dropdown synced to the railpack
 * GitHub releases (served by `/api/railpack-versions`, cached server-side).
 *
 * Free-text is allowed — the field accepts "latest", a concrete tag ("v0.9.0"),
 * or anything the user types; the dropdown is only a hint. Versions load lazily
 * on first focus so the network call happens only when the field is opened.
 */
export interface RailpackVersionInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}

/** Fetch the release tags; each tag is both the stored value and the label. */
async function loadRailpackVersions(): Promise<VersionItem[]> {
  const r = await fetch("/api/railpack-versions");
  const j = await r.json();
  const list: string[] = Array.isArray(j.versions) ? j.versions : [];
  return list.map((v) => ({ value: v, label: v }));
}

export function RailpackVersionInput({
  value,
  onChange,
  placeholder = "latest",
  id,
  className,
}: RailpackVersionInputProps) {
  return (
    <VersionCombobox
      value={value}
      onChange={onChange}
      load={loadRailpackVersions}
      placeholder={placeholder}
      id={id}
      className={className}
    />
  );
}

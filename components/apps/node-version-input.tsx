"use client";

import * as React from "react";
import {
  VersionCombobox,
  type VersionItem,
} from "@/components/services/version-combobox";

/**
 * Node.js version input with an autocomplete dropdown synced to the real Node
 * release train (served by `/api/node-versions`, cached server-side from
 * nodejs.org/dist). The stored value is a bare MAJOR ("22", "20") — what the
 * builders pin — while the dropdown labels carry the LTS codename.
 *
 * Free-text is allowed: the field accepts a bare major, a full version, or blank
 * (blank ⇒ let the builder auto-detect the version from the project).
 */
export interface NodeVersionInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}

/** Fetch + normalise the Node major list; tolerant of the plain-string shape. */
async function loadNodeVersions(): Promise<VersionItem[]> {
  const r = await fetch("/api/node-versions");
  const j = await r.json();
  const list = Array.isArray(j.versions) ? j.versions : [];
  return list.map((v: unknown) =>
    typeof v === "string"
      ? { value: v, label: v }
      : { value: String((v as VersionItem).value), label: String((v as VersionItem).label) },
  );
}

export function NodeVersionInput({
  value,
  onChange,
  placeholder = "Default (auto-detect)",
  id,
  className,
}: NodeVersionInputProps) {
  return (
    <VersionCombobox
      value={value}
      onChange={onChange}
      load={loadNodeVersions}
      placeholder={placeholder}
      id={id}
      className={className}
    />
  );
}

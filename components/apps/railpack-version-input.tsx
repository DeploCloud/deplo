"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import {
  VersionCombobox,
  type VersionItem,
} from "@/components/apps/version-combobox";

/**
 * Railpack version input with an autocomplete dropdown synced to the railpack
 * GitHub releases (served by `/api/railpack-versions`, cached server-side).
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

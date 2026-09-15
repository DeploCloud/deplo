"use client";

import * as React from "react";
import {
  VersionCombobox,
  type VersionItem,
} from "@/components/apps/version-combobox";

export interface NodeVersionInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}

async function loadNodeVersions(): Promise<VersionItem[]> {
  const r = await fetch("/api/node-versions");
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

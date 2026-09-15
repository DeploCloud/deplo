"use client";

import * as React from "react";
import { Database as DatabaseIcon } from "lucide-react";
import { LogoImage } from "@/components/shared/project-logo";
import { DB_LOGOS } from "@/components/storage/db-engines";
import type { DatabaseType } from "@/lib/types/database";

export function DatabaseLogo({
  type,
  logo = null,
  size = 36,
  className,
}: {
  type: DatabaseType;
  logo?: string | null;
  size?: number;
  className?: string;
}) {
  return (
    <LogoImage
      src={logo ?? DB_LOGOS[type] ?? null}
      size={size}
      className={className}
      fallback={
        <DatabaseIcon style={{ width: size * 0.5, height: size * 0.5 }} />
      }
    />
  );
}

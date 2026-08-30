"use client";

import * as React from "react";
import { Database as DatabaseIcon } from "lucide-react";
import { LogoImage } from "@/components/shared/project-logo";
import { DB_LOGOS } from "@/components/storage/db-engines";
import type { DatabaseType } from "@/lib/types";

/**
 * A database's display avatar - the twin of `AppLogo`, with one difference: a
 * database is never logo-less.
 */
export function DatabaseLogo({
  type,
  logo = null,
  size = 36,
  className,
}: {
  type: DatabaseType;
  /** The database's own uploaded logo. Null ⇒ fall back to the engine mark. */
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

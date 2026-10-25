"use client";

import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import type { SecuritySubject } from "@/lib/security-updates/subjects";

export function SubjectLogo({
  subject: s,
  size,
}: {
  subject: SecuritySubject;
  size: number;
}) {
  return s.kind === "database" && s.databaseType ? (
    <DatabaseLogo type={s.databaseType} logo={s.logo} size={size} />
  ) : (
    <AppLogo logo={s.logo} tone={s.logoTone} size={size} />
  );
}

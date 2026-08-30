// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

/** The page moved to Settings, Migrations. Old links keep working. */
export default function ImportRedirect() {
  redirect("/settings/migrations");
}

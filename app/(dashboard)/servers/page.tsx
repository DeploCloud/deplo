// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

/**
 * Servers moved under Settings (it is now a settings section, reached from the
 * settings sidebar). Keep this path working for old bookmarks/links.
 */
export default function ServersRedirect() {
  redirect("/settings/servers");
}

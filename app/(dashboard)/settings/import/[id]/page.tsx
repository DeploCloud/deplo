// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

/**
 * A finished run no longer has a page of its own - the report opens in a dialog,
 * from the wizard that just ran it or from the History tab. A bookmarked run
 * lands on that tab.
 */
export default function ImportRunRedirect() {
  redirect("/settings/migrations?tab=history");
}

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

/**
 * Members moved under Settings → Team, next to the Roles page that defines what
 * a member can do - the two are one decision, not two sections. This stub only
 * keeps old bookmarks and links working.
 */
export default function MembersIndex() {
  redirect("/settings/members");
}

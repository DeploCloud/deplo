// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

/**
 * Projects no longer have a page of their own: containers live on the Overview
 * (`/`), which also hosts each container's drill-in view (`/?project=<id>`).
 * This stub only keeps old bookmarks working.
 */
export default function ProjectsIndex() {
  redirect("/");
}

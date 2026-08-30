// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

/** The database twin of the app's stub: the switch moved to Advanced settings. */
export default async function DatabaseCronSettingsRedirect(
  props: PageProps<"/storage/databases/[id]/settings/cron-jobs">,
) {
  const { id } = await props.params;
  redirect(`/storage/databases/${id}/settings/advanced`);
}

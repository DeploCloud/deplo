// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { RAW_INSTALL_URL } from "@/lib/install-script";

/**
 * Short alias for the installer.
 */
export function GET() {
  redirect(RAW_INSTALL_URL);
}

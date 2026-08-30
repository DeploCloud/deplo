// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Badge } from "@/components/ui/badge";

/**
 * The one spelling of "this is beta", so a feature carrying it looks the same
 * everywhere it appears.
 */
export function BetaChip() {
  return (
    <Badge variant="info" className="text-[10px] font-normal uppercase">
      Beta
    </Badge>
  );
}

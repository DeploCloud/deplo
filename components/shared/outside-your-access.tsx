// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Lock } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";

/**
 * A whole page a member on a LIMITED role cannot have, rendered as a page rather
 * than thrown.
 */
export function OutsideYourAccess({
  title,
  description,
  what,
}: {
  /** The page's own title, so the header is unchanged from the normal render. */
  title: string;
  /** The page's own subtitle. */
  description: string;
  /** What the member is missing, as a sentence subject: "The member roster". */
  what: string;
}) {
  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description={description}
        docs="roles.floorCeiling"
      />
      <EmptyState
        icon={Lock}
        title="Outside your access"
        description={`Your role reaches part of this team. ${what} belongs to the whole of it.`}
      />
    </div>
  );
}

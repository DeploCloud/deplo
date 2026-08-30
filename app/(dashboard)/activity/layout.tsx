// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { PageHeader } from "@/components/shared/page-header";

// The header is static, so it belongs above the page's Suspense boundary: it
// arrives with the shell instead of being redrawn as a skeleton bar.
export default function ActivityLayout(props: LayoutProps<"/activity">) {
  return (
    <div className="space-y-2">
      <PageHeader
        docs="team.activity"
        title="Activity"
        description="A log of everything happening across your workspace."
      />
      {props.children}
    </div>
  );
}

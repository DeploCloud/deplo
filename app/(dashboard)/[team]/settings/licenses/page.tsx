import { readFile } from "node:fs/promises";
import path from "node:path";
import { Download } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import {
  LicensesPanel,
  type Notice,
} from "@/components/settings/licenses-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DEPLO_VERSION } from "@/lib/version";

export const metadata = { title: "Settings · Licenses" };

// Written next to the build by scripts/third-party-notices.mjs.
async function readNotices(): Promise<Notice[]> {
  try {
    const file = path.join(process.cwd(), "public", "third-party-notices.json");
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

export default async function SettingsLicensesPage() {
  const notices = await readNotices();
  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Open source licenses
            <Badge variant="secondary" className="tabular-nums">
              {notices.length}
            </Badge>
          </span>
        }
        description={`The open source packages inside Deplo v${DEPLO_VERSION}, each under its own license.`}
        actions={
          notices.length > 0 && (
            <Button asChild size="sm" variant="outline">
              <a href="/third-party-notices.txt" download>
                <Download className="size-4" />
                Download
              </a>
            </Button>
          )
        }
      />
      <LicensesPanel notices={notices} />
    </div>
  );
}

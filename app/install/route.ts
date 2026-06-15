import { redirect } from "next/navigation";
import { RAW_INSTALL_URL } from "@/lib/install-script";

/**
 * Short alias for the installer. The canonical script lives on GitHub
 * (`install.sh`); this endpoint redirects there so the historical one-liner
 *   curl -fsSL https://<host>/install | bash
 * keeps working (curl -fsSL follows the redirect).
 */
export function GET() {
  redirect(RAW_INSTALL_URL);
}

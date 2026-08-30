import { redirect } from "next/navigation";
import { RAW_INSTALL_URL } from "@/lib/install-script";

/**
 * Short alias for the installer.
 */
export function GET() {
  redirect(RAW_INSTALL_URL);
}

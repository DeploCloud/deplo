import { redirect } from "next/navigation";
import { RAW_INSTALL_URL } from "@/lib/install-script";

export function GET() {
  redirect(RAW_INSTALL_URL);
}

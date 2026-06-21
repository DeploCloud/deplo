import { redirect } from "next/navigation";

/**
 * Servers moved under Settings (it is now a settings section, reached from the
 * settings sidebar). Keep this path working for old bookmarks/links.
 */
export default function ServersRedirect() {
  redirect("/settings/servers");
}

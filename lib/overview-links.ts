/**
 * Overview drill-in URL builders. A PLAIN module (no "use client") on purpose:
 * the Overview server component builds these hrefs too, and calling a function
 * exported from a client module inside an RSC render throws at runtime
 * ("Attempted to call … from the server"). Client components import from here
 * as well, so the two sides can never disagree on the URL shape.
 */

/** Build the Overview URL that opens a project, preserving the list/grid view. */
export function projectHref(id: string, view: "grid" | "list" = "grid"): string {
  const params = new URLSearchParams();
  params.set("project", id);
  if (view === "list") params.set("view", "list");
  return `/?${params.toString()}`;
}

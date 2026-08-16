import { Skeleton } from "@/components/ui/skeleton";

/**
 * The fallback for the role OPEN ON THE RIGHT — and nothing else.
 *
 * `loading.tsx` is nested INSIDE its segment's layout and wraps only the page
 * below it (Next.js streaming guide: "loading.js is nested inside layout.js and
 * wraps page.js in a Suspense boundary"). Roles has a layout of its own, so what
 * this replaces is `{children}` — the detail column — while the real page header
 * and the real rail of roles are already painted around it.
 *
 * That is why this used to look broken: it drew a whole page (header, rail,
 * detail) and Next rendered all of it inside the detail column, beside a rail
 * that was already showing the actual roles. The rail staying put is the point
 * of a master-detail section, not a bug — the skeleton just has to be the shape
 * of the ONE thing that is still loading.
 *
 * Worth keeping rather than deleting: opening a role awaits three reads, and one
 * of them (`listTeamScopeTree`) walks the team's whole project/environment/
 * folder/app graph. `new` renders the same editor, and the index page under it
 * only checks a capability — it resolves before a frame, so its fallback is
 * never actually seen.
 */
export default function Loading() {
  return (
    <div
      // The editor's own grid, so the real thing lands exactly where its
      // skeleton was instead of stepping sideways as it arrives.
      className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]"
      role="status"
      aria-busy
      aria-label="Loading role"
    >
      <div className="space-y-4">
        {/* Details: name, description, colour. */}
        <Skeleton shimmer className="h-44 w-full rounded-xl" />
        {/* The permission picker, which is most of the page. */}
        <Skeleton
          shimmer
          style={{ ["--shimmer-delay" as string]: "-0.09s" }}
          className="h-96 w-full rounded-xl"
        />
      </div>
      {/* The summary rail: what the role adds up to. */}
      <Skeleton
        shimmer
        style={{ ["--shimmer-delay" as string]: "-0.18s" }}
        className="h-72 w-full rounded-xl"
      />
    </div>
  );
}

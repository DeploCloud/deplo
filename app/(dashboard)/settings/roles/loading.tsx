import { Skeleton } from "@/components/ui/skeleton";

/**
 * The fallback for the role OPEN ON THE RIGHT — and nothing else. `new` renders
 * the same editor, and the index page under it only checks a capability — it
 * resolves before a frame, so its fallback is never actually seen.
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

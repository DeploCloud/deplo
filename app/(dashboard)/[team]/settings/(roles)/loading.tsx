import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

// [name, summary] per role in the rail: the three every team starts with.
const ROLES: [string, string][] = [
  ["w-12", "w-28"],
  ["w-14", "w-32"],
  ["w-16", "w-24"],
];

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading roles"
    >
      <div className="space-y-1">
        <TextLine type={titleClass.page} className="w-16" />
        <TextLine
          type="text-sm leading-[1.6]"
          className="w-[36rem] max-w-full"
        />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(220px,260px)_1fr]">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <TextLine type="text-xs font-semibold" className="w-14" />
            <Skeleton className="h-8 w-[104px]" />
          </div>
          <div className="space-y-1">
            {ROLES.map(([name, summary], i) => (
              <div
                key={i}
                className="flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2"
              >
                <Skeleton className="size-7 shrink-0" />
                <div className="min-w-0 flex-1">
                  <TextLine type="text-sm font-medium" className={name} />
                  <TextLine type="text-xs" className={summary} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
          <Skeleton className="mb-4 size-12 rounded-full" />
          <TextLine
            type="justify-center text-sm font-medium"
            className="w-56"
          />
          <div className="mt-1 w-full max-w-sm">
            {["w-full", "w-11/12", "w-2/3"].map((w) => (
              <TextLine
                key={w}
                type="justify-center text-sm leading-[1.6]"
                className={w}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

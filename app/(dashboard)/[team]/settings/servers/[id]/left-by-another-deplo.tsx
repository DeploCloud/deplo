import { DocsLink } from "@/components/ui/docs-link";
import type { LeftByAnotherDeplo } from "@/lib/data/servers/panel-claim";

const counted = (n: number, word: string) =>
  n === 0 ? null : `${n} ${word}${n === 1 ? "" : "s"}`;

// What another Deplo left here (ADR-0050): said once it is set aside, and its Apps listed while they remain.
export function LeftByAnotherDeploNote({
  state,
}: {
  state: LeftByAnotherDeplo;
}) {
  const apps = [...new Set(state.left.map((l) => l.app))].sort();
  const what = [
    counted(
      state.left.filter((l) => l.kind === "container").length,
      "container",
    ),
    counted(state.left.filter((l) => l.kind === "volume").length, "volume"),
  ]
    .filter(Boolean)
    .join(" and ");
  return (
    <div className="max-w-2xl space-y-1 text-sm">
      <p className="text-muted-foreground">
        Set aside what another Deplo left on this machine.{" "}
        <DocsLink topic="servers.anotherDeplo" />
      </p>
      {apps.length > 0 && (
        <p className="text-muted-foreground">
          Its Apps&apos; {what} are untouched, for you to decide:{" "}
          <span className="text-foreground">{apps.join(", ")}</span>
        </p>
      )}
    </div>
  );
}

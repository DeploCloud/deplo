import {
  appSecurityUpdates,
  databaseSecurityUpdates,
  type SecurityUpdates,
} from "@/lib/data/security-updates/read";
import {
  SecurityUpdatesBanner,
  type BannerProps,
} from "./security-updates-banner";

function topAction(
  s: SecurityUpdates,
  kind: "app" | "database",
): BannerProps["action"] {
  const live = s.updates.filter((u) => u.actionable);
  if (live.some((u) => u.fix === "update")) return "update";
  if (kind === "database") return null;
  if (live.some((u) => u.fix === "rebuild")) return "rebuild";
  if (s.newerTag && live.some((u) => u.fix === "newer_tag")) return "newer_tag";
  return null;
}

// Shown only while something can be acted on; nothing when all is well.
export async function SecurityUpdatesNotice(
  props:
    | { kind: "app"; id: string; slug: string; name: string }
    | { kind: "database"; id: string; name: string },
) {
  const s =
    props.kind === "app"
      ? await appSecurityUpdates(props.id)
      : await databaseSecurityUpdates(props.id);
  if (!s || s.count === 0) return null;
  return (
    <SecurityUpdatesBanner
      name={props.name}
      count={s.count}
      exploited={s.exploited}
      action={topAction(s, props.kind)}
      newerTag={s.newerTag}
      {...(props.kind === "app"
        ? { appId: props.id, slug: props.slug }
        : { databaseId: props.id })}
    />
  );
}

import Link from "@/components/ui/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { TemplateSearchLink } from "@/components/templates/template-search";
import { templatesHref, type OverviewPlacement } from "@/lib/overview-links";

export function TopBar({ placement }: { placement: OverviewPlacement | null }) {
  const scope = templatesHref(placement).split("?")[1] ?? "";
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <Link
        href={templatesHref(placement)}
        className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Templates
      </Link>
      <TemplateSearchLink scope={scope} className="w-full sm:w-72" />
    </div>
  );
}

export function DeployButton({
  canDeploy,
  href,
}: {
  canDeploy: boolean;
  href: string;
}) {
  if (canDeploy)
    return (
      <Button asChild className="shrink-0 sm:w-32">
        <Link href={href}>
          Deploy
          <ArrowUpRight className="size-4" />
        </Link>
      </Button>
    );
  return (
    <SimpleTooltip content="Needs the “Create apps” permission">
      <span tabIndex={0} className="shrink-0">
        <Button disabled className="w-full sm:w-32">
          Deploy
          <ArrowUpRight className="size-4" />
        </Button>
      </span>
    </SimpleTooltip>
  );
}

export function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

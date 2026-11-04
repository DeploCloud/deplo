import { Skeleton, Bone } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { cn } from "@/lib/utils";
import { CardSkeleton } from "@/components/templates/store-skeleton";
import { TemplateRail } from "@/components/templates/template-rail";
import { TrademarkNote } from "@/components/templates/trademark-note";
import { DeployButton, Row, TopBar } from "./template-parts";

// Most templates name all six; the last three are links with an icon.
const ROWS: [string, boolean][] = [
  ["Category", false],
  ["Developed by", false],
  ["Submitted by", false],
  ["Source code", true],
  ["Website", true],
  ["Documentation", true],
];
const PARAGRAPHS = [
  "A self-contained service you can deploy in one click, with its storage and its address set up for you. It starts with sensible defaults, keeps its data across redeploys, and updates when you choose to. Everything it needs is described in the template, so a deploy gives you the same result every time.",
  "Open it once it is live to finish the first-run setup.",
];

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8" aria-busy>
      <TopBar placement={null} />

      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Skeleton className="size-[72px] shrink-0 rounded-2xl" />
          <div className="min-w-0">
            <h1 className={cn("truncate", titleClass.page)}>
              <Bone>Template name</Bone>
            </h1>
            <p className="mt-1 text-sm text-balance text-muted-foreground">
              <Bone>A short description of what this template runs.</Bone>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          <Bone box className="max-sm:w-full">
            <DeployButton canDeploy={false} href="" />
          </Bone>
        </div>
      </div>

      <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        {PARAGRAPHS.map((text, i) => (
          <p key={i}>
            <Bone>{text}</Bone>
          </p>
        ))}
      </div>

      <dl className="grid gap-x-8 gap-y-4 border-t border-border pt-6 sm:grid-cols-2">
        {ROWS.map(([label, icon]) => (
          <Row key={label} label={label}>
            <span className="inline-flex items-center gap-1.5">
              {icon && <Skeleton className="size-3.5 rounded-sm" />}
              <Bone>Placeholder</Bone>
            </span>
          </Row>
        ))}
      </dl>

      <div className="border-t border-border pt-6">
        <TemplateRail title="Related">
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} className="w-72 shrink-0 snap-start" />
          ))}
        </TemplateRail>
      </div>

      <TrademarkNote />
    </div>
  );
}

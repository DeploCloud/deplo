import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  CloudOff,
  Globe,
  Package,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { LogoImage } from "@/components/shared/project-logo";
import { CategoryIcon } from "@/components/templates/category-icon";
import {
  TemplateCard,
  toStoreTemplate,
} from "@/components/templates/template-card";
import { plateClass, veilProps } from "@/components/templates/veil";
import { TemplateMarkdown } from "@/components/templates/template-markdown";
import { TemplateRail } from "@/components/templates/template-rail";
import { TemplateSearchLink } from "@/components/templates/template-search";
import { TemplateScreenshots } from "@/components/templates/template-screenshots";
import { hasCapability } from "@/lib/membership";
import { cn } from "@/lib/utils";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import {
  newAppHref,
  placementFromSearchParams,
  templatesHref,
  type OverviewPlacement,
} from "@/lib/overview-links";
import { templateAccent, templateAccents } from "@/lib/templates/logo-color";
import { getTemplate, listCatalog, templateAssetUrl } from "@/templates/catalog";

/** How many siblings the Related rail carries. */
const RELATED = 12;

export async function generateMetadata(props: PageProps<"/templates/[slug]">) {
  const { slug } = await props.params;
  const template = await getTemplate(slug).catch(() => null);
  return { title: template ? template.name : "Template" };
}

export default async function TemplatePage(props: PageProps<"/templates/[slug]">) {
  const [{ slug }, searchParams] = await Promise.all([
    props.params,
    props.searchParams,
  ]);

  const [placement, canDeploy, template] = await Promise.all([
    resolveOverviewPlacement(placementFromSearchParams(searchParams)),
    hasCapability("create_apps"),
    // A stale `?template=` link degrades to "not available" rather than a 500,
    // and an unreachable catalogue says so instead of taking the page down.
    getTemplate(slug).catch(() => null),
  ]);

  if (!template)
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <TopBar placement={placement} />
        <EmptyState
          icon={CloudOff}
          title="That template isn't available"
          description="It may have been renamed or removed from the catalog, or the catalog could not be reached."
          action={
            <Button asChild size="sm">
              <Link href={templatesHref(placement)}>Back to templates</Link>
            </Button>
          }
        />
      </div>
    );

  // `getTemplate` hands back the raw entry: unlike `listCatalog` it does not
  // resolve asset paths, so the URLs are built here.
  const logo = template.logo ? templateAssetUrl(template.logo) : null;
  const images = template.images.map(templateAssetUrl);
  const accent = await templateAccent(template.slug, logo);
  const veil = veilProps(accent, "on");

  const catalog = await listCatalog().catch(() => []);
  const related = catalog
    .filter((t) => t.slug !== template.slug && t.category.slug === template.category.slug)
    .slice(0, RELATED);
  const relatedAccents = await templateAccents(related);

  const deployHref = newAppHref(placement, { template: template.slug });

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <TopBar placement={placement} />

      {/* Header: the logo sits on its own wash, in its own colour. */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div
            style={veil.style}
            className={cn(
              "flex size-18 shrink-0 items-center justify-center rounded-2xl border border-border",
              veil.className,
            )}
          >
            <LogoImage
              src={logo}
              size={48}
              className={cn("tpl-logo", plateClass(accent))}
              fallback={<Package className="size-6 text-muted-foreground" />}
            />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {template.name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {template.shortDescription}
            </p>
          </div>
        </div>
        <DeployButton canDeploy={canDeploy} href={deployHref} />
      </div>

      {images.length > 0 && (
        <TemplateScreenshots images={images} name={template.name} />
      )}

      <TemplateMarkdown source={template.description} />

      {/* Metadata. Every row is a fact the catalogue carries; nothing is faked
          when it is missing, the row simply isn't there. */}
      <dl className="grid gap-x-8 gap-y-4 border-t border-border pt-6 sm:grid-cols-2">
        <Row label="Category">
          <span className="flex items-center gap-1.5">
            <CategoryIcon
              icon={template.category.icon}
              className="size-4 text-muted-foreground"
            />
            {template.category.name}
          </span>
        </Row>
        <Row label="Developed by">
          <ExternalLink
            href={template.developedBy.url}
            label={template.developedBy.label}
          />
        </Row>
        <Row label="Submitted by">
          <ExternalLink
            href={template.submittedBy.url}
            label={template.submittedBy.label}
          />
        </Row>
        {template.links.github && (
          <Row label="Source code">
            <ExternalLink
              href={template.links.github}
              label="GitHub"
              icon={<GitHubIcon className="size-3.5" />}
            />
          </Row>
        )}
        {template.links.website && (
          <Row label="Website">
            <ExternalLink
              href={template.links.website}
              label={hostOf(template.links.website)}
              icon={<Globe className="size-3.5" />}
            />
          </Row>
        )}
        {template.links.docs && (
          <Row label="Documentation">
            <ExternalLink
              href={template.links.docs}
              label={hostOf(template.links.docs)}
              icon={<BookOpen className="size-3.5" />}
            />
          </Row>
        )}
      </dl>

      {related.length > 0 && (
        <div className="border-t border-border pt-6">
          <TemplateRail title="Related">
            {related.map((t) => (
              <TemplateCard
                key={t.slug}
                template={toStoreTemplate(t)}
                accent={relatedAccents[t.slug]}
                href={`/templates/${t.slug}`}
                className="w-72 shrink-0 snap-start"
              />
            ))}
          </TemplateRail>
        </div>
      )}
    </div>
  );
}

/**
 * The way back and the way sideways. The search stays on this page on purpose:
 * a store you can only search from its front page makes you go back before you
 * can look for the next thing.
 */
function TopBar({ placement }: { placement: OverviewPlacement | null }) {
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

function DeployButton({
  canDeploy,
  href,
}: {
  canDeploy: boolean;
  href: string;
}) {
  if (canDeploy)
    return (
      <Button asChild className="shrink-0 sm:w-40">
        <Link href={href}>
          Deploy
          <ArrowUpRight className="size-4" />
        </Link>
      </Button>
    );
  return (
    // A disabled button swallows pointer events, so the tooltip needs a
    // focusable wrapper to stay reachable.
    <SimpleTooltip content="Needs the “Create apps” permission">
      <span tabIndex={0} className="shrink-0">
        <Button disabled className="w-full sm:w-40">
          Deploy
          <ArrowUpRight className="size-4" />
        </Button>
      </span>
    </SimpleTooltip>
  );
}

function Row({
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

function ExternalLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 hover:text-muted-foreground"
    >
      {icon}
      {label}
    </a>
  );
}

/** The bare host, so a metadata row never wraps onto three lines. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

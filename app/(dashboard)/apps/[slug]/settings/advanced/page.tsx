import { notFound } from "next/navigation";
import Link from "next/link";
import { SlidersHorizontal, SquareTerminal } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DangerSettings } from "@/components/apps/settings/danger-settings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = { title: "Advanced" };

/**
 * Advanced app settings: the powerful, less-everyday controls in one place — an
 * entry point into the container Console, and the Danger Zone (delete). Folding
 * both under "Advanced" keeps a destructive action off the everyday sections, so
 * it's never one stray click away from Name & logo.
 */
export default async function AppAdvancedSettingsPage(
  props: PageProps<"/apps/[slug]/settings/advanced">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={SlidersHorizontal}
        title="Advanced"
        info="Open the container console, or permanently delete this app."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SquareTerminal className="size-4 text-muted-foreground" />
            Console
          </CardTitle>
          <CardDescription>
            Open an interactive terminal in the running container — run commands
            with <span className="font-mono">docker exec</span>, or attach to its
            live output. Available whenever the app is running; no SSH needed.
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-end">
          <Button asChild size="sm" variant="outline">
            <Link href={`/apps/${slug}/console`}>
              <SquareTerminal className="size-4" />
              Open console
            </Link>
          </Button>
        </CardFooter>
      </Card>

      <DangerSettings appId={project.id} name={project.name} />
    </section>
  );
}

import { notFound } from "next/navigation";
import Link from "next/link";
import { SlidersHorizontal, SquareTerminal } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { hasCapability } from "@/lib/membership";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DatabaseImageSettings } from "@/components/storage/database-image-settings";
import { DatabaseDanger } from "@/components/storage/database-danger";
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
 * Advanced: the powerful, less-everyday controls in one place — the entry point
 * into the container Console, expert image/command/version overrides (applied on
 * the next Redeploy) and the Danger Zone (rebuild from scratch, delete with
 * artifacts). The exact shape of an App's Advanced, including where the console
 * is found: its sidebar chip only appears once the warning here is accepted, so
 * this card is how a database console is discovered in the first place.
 */
export default async function DatabaseAdvancedSettingsPage(
  props: PageProps<"/storage/databases/[id]/settings/advanced">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();
  // A live shell into the container is infra-class — the console page itself
  // gates on manage_infra, so don't advertise a door the viewer can't open.
  const canConsole = await hasCapability("open_database_console");

  return (
    <section className="space-y-6">
      <SettingsSection
        icon={SlidersHorizontal}
        title="Advanced"
        info="Open the database console, override the engine image or command, rebuild the database from scratch, or delete it."
      />

      {canConsole && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SquareTerminal className="size-4 text-muted-foreground" />
              Console
            </CardTitle>
            <CardDescription>
              Open an interactive terminal in the database&apos;s container — run{" "}
              <span className="font-mono">psql</span>,{" "}
              <span className="font-mono">redis-cli</span> or any other client
              with <span className="font-mono">docker exec</span>. Available
              whenever the database is running; no SSH needed.
            </CardDescription>
          </CardHeader>
          <CardFooter className="justify-end">
            <Button asChild size="sm" variant="outline">
              <Link href={`/storage/databases/${id}/console`}>
                <SquareTerminal className="size-4" />
                Open console
              </Link>
            </Button>
          </CardFooter>
        </Card>
      )}

      <DatabaseImageSettings db={db} />
      <DatabaseDanger db={db} />
    </section>
  );
}

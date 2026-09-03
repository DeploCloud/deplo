import Link from "@/components/ui/link";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TeamAvatar } from "@/components/shared/user-avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * What a link to a team you are not in opens - the same answer a team that does
 * not exist gets, so the address gives nothing away either way.
 */
export function NoTeamAccessScreen({
  teams,
}: {
  teams: { id: string; name: string; slug: string; avatarUrl: string | null }[];
}) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted">
            <Lock className="size-5 text-muted-foreground" />
          </div>
          <CardTitle>No access to this team</CardTitle>
          <CardDescription className="mt-1">
            This address is not one of your teams. Ask whoever administers it to
            add you, or open one of yours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {teams.map((t) => (
              <Button key={t.id} asChild variant="outline" size="sm">
                <Link href={`/${t.slug}`}>
                  <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="sm" />
                  {t.name}
                </Link>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

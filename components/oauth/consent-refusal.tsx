import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConsentShell } from "@/components/oauth/consent-shell";

/**
 * Why a connection cannot be approved, said in one line.
 *
 * Never a bare redirect: the person is mid-flow inside someone else's product
 * and a silent bounce to the dashboard reads as deplo being broken. There is a
 * way back, and it does not pretend the connection succeeded.
 */
export function ConsentRefusal({
  clientName,
  title,
  detail,
}: {
  clientName?: string;
  title: string;
  detail: string;
}) {
  return (
    <ConsentShell>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            {clientName
              ? `${clientName} has not been given any access.`
              : "Nothing has been connected."}
          </p>
          <Button asChild variant="outline">
            <Link href="/">Back to deplo</Link>
          </Button>
        </CardContent>
      </Card>
    </ConsentShell>
  );
}

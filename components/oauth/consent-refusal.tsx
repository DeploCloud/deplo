import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
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
      {/* Same centred column as the approval screen, so the two read as one
          product rather than as a screen and its error page. */}
      <Card>
        <div className="grid justify-items-center gap-4 p-6 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-muted">
            <ShieldAlert className="size-6 text-muted-foreground" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
          </div>
          <Button asChild variant="outline" className="w-full">
            <Link href="/">Back to deplo</Link>
          </Button>
        </div>
      </Card>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        {clientName
          ? `${clientName} has not been given any access.`
          : "Nothing has been connected."}
      </p>
    </ConsentShell>
  );
}

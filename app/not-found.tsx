import Link from "next/link";
import { DeploMark } from "@/components/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <DeploMark size={40} className="opacity-80" />
      <div className="space-y-1">
        <p className="text-5xl font-semibold tracking-tight">404</p>
        <p className="text-muted-foreground">
          This page could not be found.
        </p>
      </div>
      <Button asChild>
        <Link href="/">Back to dashboard</Link>
      </Button>
    </div>
  );
}

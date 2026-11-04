import Link from "@/components/ui/link";
import { X } from "lucide-react";

import { DeploLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The focus layout's backdrop, shared with the loading state drawn before that layout resolves. */
export function FocusBackdrop({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-dvh">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

export function FocusFrame({
  exitHref,
  narrow,
  children,
}: {
  exitHref: string;
  narrow?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <Link href="/" className="cursor-pointer">
          <DeploLogo />
        </Link>
        <Button variant="ghost" size="icon" asChild aria-label="Close">
          <Link href={exitHref}>
            <X className="size-5" />
          </Link>
        </Button>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className={cn("w-full", narrow ? "max-w-lg" : "max-w-2xl")}>
          {children}
        </div>
      </main>
    </div>
  );
}

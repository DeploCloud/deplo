import Link from "@/components/ui/link";
import { DeploLogo } from "@/components/logo";

// ConsentShell is the sign-in shell without its layout, which redirects a signed-in user away.
export function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0" />
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Link href="/" className="cursor-pointer">
            <DeploLogo className="text-3xl" />
          </Link>
        </div>
        {children}
      </div>
    </div>
  );
}

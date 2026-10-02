import Link from "@/components/ui/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSetupNeeded } from "@/lib/auth/setup";
import { instanceFrozen } from "@/lib/data/deplo-move/freeze";
import { AuthChrome } from "@/components/auth/auth-chrome";
import { DeploLogo } from "@/components/logo";
import { PeerLink } from "@/components/deplo-move/peer-link";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/");
  if (await isSetupNeeded()) redirect("/setup");
  const frozen = await instanceFrozen();
  const movedTo = frozen?.moved ? frozen.peerUrl : null;

  return (
    <div className="relative grid min-h-dvh place-items-center px-4 pt-10 pb-16">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0" />
      <AuthChrome />
      <div className="relative z-10 w-full max-w-sm">
        <div className="animate-soft-in mb-8 flex justify-center">
          <Link href="/" className="cursor-pointer">
            <DeploLogo className="text-3xl" />
          </Link>
        </div>
        {movedTo && (
          <p className="mb-5 rounded-lg border border-info/40 bg-info-wash px-3 py-2 text-center text-sm">
            This Deplo moved to <PeerLink url={movedTo} />.
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

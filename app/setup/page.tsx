import { redirect } from "next/navigation";
import { isSetupNeeded } from "@/lib/auth";
import { DeploLogo } from "@/components/logo";
import { SetupForm } from "@/components/auth/setup-form";

export const metadata = { title: "Set up Deplo" };

export default async function SetupPage() {
  // Once an account exists the wizard is done; send people to sign in.
  if (!(await isSetupNeeded())) redirect("/login");

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0 opacity-[0.35]" />
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <DeploLogo className="text-base" />
        </div>
        <SetupForm />
      </div>
      <p className="relative z-10 mt-8 text-center text-xs text-muted-foreground">
        Deplo — self-hosted deployments with Docker &amp; Traefik
      </p>
    </div>
  );
}

import { redirect } from "next/navigation";
import { isSetupNeeded } from "@/lib/auth";
import { OnboardingWizard } from "@/components/auth/onboarding-wizard";

export const metadata = { title: "Set up Deplo" };

export default async function SetupPage() {
  // Once an account exists the wizard is done; send people to sign in.
  if (!(await isSetupNeeded())) redirect("/login");

  return (
    <div className="relative grid min-h-dvh place-items-center px-4 pt-10 pb-16">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0 opacity-[0.35]" />
      <div className="relative z-10 flex w-full justify-center">
        <OnboardingWizard />
      </div>
    </div>
  );
}

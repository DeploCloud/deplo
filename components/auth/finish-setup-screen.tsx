import { OnboardingWizard } from "@/components/auth/onboarding-wizard";

export function FinishSetupScreen({ email }: { email: string }) {
  return (
    <div className="relative grid min-h-dvh place-items-center px-4 pt-10 pb-16">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0" />
      <div className="z-10 flex w-full justify-center">
        <OnboardingWizard finishEmail={email} />
      </div>
    </div>
  );
}

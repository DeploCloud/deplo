import Link from "@/components/ui/link";
import { redirect } from "next/navigation";
import { checkSetupKey, isSetupNeeded } from "@/lib/auth";
import { noteBrowserReached } from "@/lib/data/takeover";
import { AuthChrome } from "@/components/auth/auth-chrome";
import { InvalidLinkGraphic } from "@/components/auth/invalid-link-graphic";
import { OnboardingWizard } from "@/components/auth/onboarding-wizard";
import { Button } from "@/components/ui/button";
import { docsUrl } from "@/lib/docs";

export const metadata = { title: "Set up Deplo" };

export default async function SetupPage(props: PageProps<"/setup">) {
  // Once an account exists the wizard is done; send people to sign in.
  if (!(await isSetupNeeded())) redirect("/login");
  // On a takeover this is the first page a browser can reach, and reaching it is
  // what tells the waiting installer that its port is open - true of a visitor
  // with no key too, so this stays ahead of the check.
  await noteBrowserReached();

  const raw = (await props.searchParams).key;
  const key = typeof raw === "string" ? raw : null;
  const state = checkSetupKey(key);

  return (
    <div className="relative grid min-h-dvh place-items-center px-4 pt-10 pb-16">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0 opacity-[0.35]" />
      <div className="relative z-10 flex w-full justify-center">
        {state === "ok" ? (
          <OnboardingWizard setupKey={key} />
        ) : (
          // Same shape as a dead registration link, and for the same reason: no
          // intro animation in front of a screen that only says "not this way".
          <>
            <AuthChrome />
            <div className="deplo-stagger w-full max-w-sm text-center">
              <InvalidLinkGraphic className="mx-auto mb-4" />
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                {state === "missing"
                  ? "This instance isn't set up yet"
                  : "That setup link isn't valid"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {state === "missing"
                  ? "Opening it needs the setup link your installer printed. Lost it? Re-run install.sh on the server and it prints the link again."
                  : "It may be an old link, or the address may have been cut short when it was copied. Re-run install.sh on the server for a fresh one."}
              </p>
              <Button asChild variant="outline" className="mt-6 w-full">
                <Link href={docsUrl("install.overview")} target="_blank">
                  Read the docs
                </Link>
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

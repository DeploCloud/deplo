"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import { cn } from "@/lib/utils";

const RETAKE = /* GraphQL */ `
  mutation RetakeScreenshot($id: String!) {
    retakeDeploymentScreenshot(deploymentId: $id) {
      id
      screenshotAt
    }
  }
`;

// https://deplo.build/docs/concepts/what-happens-on-a-deploy#a-picture-is-taken
export function DeploymentCover({
  deploymentId,
  href,
  lightUrl,
  darkUrl,
  canRetake,
}: {
  deploymentId: string;
  href: string;
  lightUrl: string;
  darkUrl: string | null;
  canRetake: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const site = href.replace(/^https?:\/\//, "");

  function retake() {
    startTransition(async () => {
      const res = await gqlAction(RETAKE, { id: deploymentId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Screenshot retaken");
      router.refresh();
    });
  }

  const img = "aspect-[8/5] w-full object-cover object-top";
  return (
    <div className="group relative self-start">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-md border border-border bg-surface outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={lightUrl}
          alt={`Screenshot of ${site}`}
          width={960}
          height={600}
          loading="lazy"
          className={cn(img, darkUrl && "dark:hidden")}
        />
        {darkUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={darkUrl}
            alt={`Screenshot of ${site}`}
            width={960}
            height={600}
            loading="lazy"
            className={cn(img, "hidden dark:block")}
          />
        )}
      </a>
      {canRetake && (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={retake}
          className={cn(
            "absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
            pending && "opacity-100",
          )}
        >
          <RefreshCw className={cn("size-4", pending && "animate-spin")} />
          Retake screenshot
        </Button>
      )}
    </div>
  );
}

// Without a picture the layout is exactly what it was before screenshots existed.
export function WithCover({
  cover,
  children,
}: {
  cover: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!cover) return children;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      {cover}
      {children}
    </div>
  );
}

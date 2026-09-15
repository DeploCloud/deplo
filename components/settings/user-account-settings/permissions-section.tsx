"use client";

import { ShieldCheck } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { RowNotice, Section, ToggleRow } from "./section-shell";

export function PermissionsSection({
  admin,
  onAdminChange,
  exposePorts,
  onExposePortsChange,
  mountHostVolumes,
  onMountHostVolumesChange,
  isSelf,
  ownerLocked,
  ownerFlagsLocked,
  advancedOpen,
  onAdvancedOpenChange,
}: {
  admin: boolean;
  onAdminChange: (v: boolean) => void;
  exposePorts: boolean;
  onExposePortsChange: (v: boolean) => void;
  mountHostVolumes: boolean;
  onMountHostVolumesChange: (v: boolean) => void;
  isSelf: boolean;
  ownerLocked: boolean;
  ownerFlagsLocked: boolean;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
}) {
  const withAdminNote = (text: string) =>
    admin ? (
      <>
        {text}
        <span className="mt-1.5 block">
          Always on for an instance admin - it applies once that switch is off.
        </span>
      </>
    ) : (
      text
    );

  return (
    <Section
      icon={ShieldCheck}
      title="Permissions"
      info={
        <>
          Instance-wide: they apply in every team and on every server. What this
          person may do inside a single team is a separate thing, set on that
          team&apos;s Members page.
        </>
      }
      docs="instance.admin"
    >
      <div>
        <ToggleRow
          title="Instance admin"
          info="Manage every user, mint registration links, and administer every team and server. Instance admins also hold both advanced grants implicitly."
          docs="instance.admin"
          checked={admin}
          disabled={isSelf || ownerFlagsLocked}
          onChange={onAdminChange}
          attached={ownerFlagsLocked || isSelf}
        />
        {(ownerFlagsLocked || isSelf) && (
          <RowNotice tone={ownerFlagsLocked ? "warning" : "muted"}>
            {ownerFlagsLocked
              ? "The instance owner is always an instance admin - transfer ownership first."
              : "You can't change your own admin status - another instance admin has to."}
          </RowNotice>
        )}
      </div>

      <Accordion
        type="single"
        collapsible
        value={advancedOpen ? "advanced" : ""}
        onValueChange={(v) => onAdvancedOpenChange(v === "advanced")}
      >
        <AccordionItem value="advanced" className="border-none">
          <AccordionTrigger className="py-1 text-xs text-muted-foreground hover:no-underline">
            Advanced grants
          </AccordionTrigger>
          <AccordionContent className="space-y-2 pt-1 pb-1">
            <ToggleRow
              title="Publish ports"
              info={withAdminNote(
                "Let a compose stack bind a port on the server itself, with a service's ports:. Public domains and routes don't need this.",
              )}
              docs="hostAccess.ports"
              checked={admin || exposePorts}
              disabled={admin || ownerLocked}
              onChange={onExposePortsChange}
            />
            <ToggleRow
              title="Bind server folders"
              info={withAdminNote(
                "Let this account point an app at a folder that already exists on the server (the Bind kind in an app's Storage settings).",
              )}
              docs="hostAccess.gated"
              checked={admin || mountHostVolumes}
              disabled={admin || ownerLocked}
              onChange={onMountHostVolumesChange}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Section>
  );
}

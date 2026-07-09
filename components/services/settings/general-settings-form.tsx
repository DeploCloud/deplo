"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Save, Image as ImageIcon, Wand2 } from "lucide-react";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ServiceLogo } from "@/components/shared/project-logo";
import {
  LOGO_ACCEPT_ATTR,
  LOGO_IMAGE_TYPES,
  MAX_LOGO_BYTES,
  isTemplateLogo,
} from "@/lib/services/logo-shared";
import { UnsavedChangesGuard } from "@/components/services/unsaved-changes-guard";
import { DirtyHint } from "@/components/services/settings/settings-shared";
import { formatBytes } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";

/**
 * General settings: a service's name and logo — its identity, so they share one
 * card. The logo saves as soon as a file is picked; the name saves with its
 * button (and arms the leave guard while dirty).
 */
export function GeneralSettingsForm({
  serviceId,
  name: initialName,
  logo: initialLogo,
  detectable = false,
}: {
  serviceId: string;
  name: string;
  logo: string | null;
  /** Whether the service has scannable source files (a GitHub repo or an
   * uploaded archive) — gates the "Detect from source" button. */
  detectable?: boolean;
}) {
  const router = useRouter();
  const [name, setName] = React.useState(initialName);
  // Logo is stored inline as a base64 image data-URI (or a template's local
  // /templates path). `null` ⇒ no logo (generic icon). The picker reads a file
  // and converts it to a data-URI before saving, so nothing is fetched remotely.
  const [logo, setLogo] = React.useState<string | null>(initialLogo);
  const logoInputRef = React.useRef<HTMLInputElement>(null);
  const [pending, startTransition] = React.useTransition();

  const [savedName, setSavedName] = React.useState(initialName);
  const nameDirty = name !== savedName;

  function saveName() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $name: String!) { renameService(id: $id, name: $name) { id } }`,
        { id: serviceId, name },
      );
      if (res.ok) {
        setSavedName(name);
        router.refresh();
        toast.success("Service renamed");
      } else toast.error(res.error);
    });
  }

  // Read a picked image into a base64 data-URI and persist it as the logo. The
  // image is validated (type + size) before reading so we never inline an
  // oversized blob into the service document.
  function pickLogo(file: File) {
    if (!LOGO_IMAGE_TYPES.includes(file.type as (typeof LOGO_IMAGE_TYPES)[number])) {
      toast.error("Unsupported image — use PNG, JPEG, WebP, GIF or SVG");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(`Image too large (max ${formatBytes(MAX_LOGO_BYTES)})`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = typeof reader.result === "string" ? reader.result : "";
      if (!dataUri) {
        toast.error("Could not read image");
        return;
      }
      setLogo(dataUri);
      startTransition(async () => {
        const res = await gqlAction(
          `mutation($id: String!, $logo: String) { updateServiceLogo(id: $id, logo: $logo) { id } }`,
          { id: serviceId, logo: dataUri },
        );
        if (res.ok) {
          router.refresh();
          toast.success("Logo updated");
        } else toast.error(res.error);
      });
    };
    reader.onerror = () => toast.error("Could not read image");
    reader.readAsDataURL(file);
  }

  function clearLogo() {
    setLogo(null);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $logo: String) { updateServiceLogo(id: $id, logo: $logo) { id } }`,
        { id: serviceId, logo: null },
      );
      if (res.ok) {
        router.refresh();
        toast.success("Logo cleared");
      } else toast.error(res.error);
    });
  }

  // Ask the server to scan the service's own source files (GitHub repo or the
  // uploaded archive) for a favicon/icon and set it as the logo. The mutation
  // errors when none is found, which we surface as an info toast.
  function detectFromSource() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!) { detectServiceLogo(id: $id) { id logo } }`,
        { id: serviceId },
        (d: { detectServiceLogo: { logo: string | null } }) => d.detectServiceLogo,
      );
      if (res.ok) {
        setLogo(res.data?.logo ?? null);
        router.refresh();
        toast.success("Logo detected from source files");
      } else toast.error(res.error);
    });
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-6 pt-6">
          {/* Logo */}
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Logo</Label>
              <p className="text-xs text-muted-foreground">
                Shown for this service on the dashboard. It&apos;s set
                automatically from a <code>favicon</code> in your source files
                (or a template&apos;s logo) — replace or remove it any time.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <ServiceLogo logo={logo} size={48} />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => logoInputRef.current?.click()}
                  disabled={pending}
                >
                  <ImageIcon className="size-4" />
                  {logo ? "Replace image" : "Upload image"}
                </Button>
                {/* A template's default icon takes priority — offer detection
                    only when the logo isn't a template default (remove it first
                    to detect one from source). Mirrors the server guard. */}
                {detectable && !isTemplateLogo(logo) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={detectFromSource}
                    disabled={pending}
                  >
                    <Wand2 className="size-4" />
                    Detect from source
                  </Button>
                )}
                {logo && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={clearLogo}
                    disabled={pending}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              PNG, JPEG, WebP, GIF, SVG or ICO · up to{" "}
              {formatBytes(MAX_LOGO_BYTES)}.
              {detectable
                ? " Saved as soon as you pick a file, or detect the favicon from your repo/upload."
                : " Saved as soon as you pick a file."}
            </p>
            <input
              ref={logoInputRef}
              type="file"
              accept={LOGO_ACCEPT_ATTR}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) pickLogo(file);
                e.target.value = "";
              }}
            />
          </div>

          {/* Name — saved with the button below; the logo saves on pick. */}
          <div className="max-w-md space-y-2 border-t border-border pt-6">
            <Label>Service name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </CardContent>
        <CardFooter className="justify-between border-t border-border pt-4">
          <DirtyHint dirty={nameDirty} />
          <Button size="sm" onClick={saveName} disabled={pending || !nameDirty}>
            <Save className="size-4" />
            Save name
          </Button>
        </CardFooter>
      </Card>

      {/* Warn before leaving with an unsaved name (the logo saves on pick). */}
      <UnsavedChangesGuard when={nameDirty} />
    </>
  );
}

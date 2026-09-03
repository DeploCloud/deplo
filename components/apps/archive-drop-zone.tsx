"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Upload } from "lucide-react";
import { toast } from "sonner";

import { validateArchive } from "@/lib/deploy/upload-client";
import { setPendingArchive } from "@/lib/deploy/pending-archive";

/**
 * Drop an archive anywhere on the page and it becomes an app. On the Overview it
 * hands the file to the wizard across a client-side navigation; inside the
 * wizard it fills the Upload step in place.
 *
 * https://deplo.build/docs/guides/deploy/upload-code
 */
export function ArchiveDropZone({
  href,
  onFile,
}: {
  /** Where to open the wizard. Ignored when `onFile` handles the drop here. */
  href?: string;
  onFile?: (file: File) => void;
}) {
  const router = useRouter();
  const [over, setOver] = React.useState(false);
  // dragenter/dragleave fire for every element the pointer crosses, so the
  // overlay is closed by a counter, never by the first leave.
  const depth = React.useRef(0);

  React.useEffect(() => {
    function carriesFiles(e: DragEvent): boolean {
      return Array.from(e.dataTransfer?.types ?? []).includes("Files");
    }
    function onEnter(e: DragEvent) {
      if (!carriesFiles(e)) return;
      depth.current += 1;
      setOver(true);
    }
    function onOver(e: DragEvent) {
      if (!carriesFiles(e)) return;
      e.preventDefault();
    }
    function onLeave(e: DragEvent) {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    }
    function onDrop(e: DragEvent) {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const problem = validateArchive(file);
      if (problem) {
        toast.error(problem);
        return;
      }
      if (onFile) {
        onFile(file);
        return;
      }
      setPendingArchive(file);
      router.push(href ?? "/new?source=upload");
    }
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [href, onFile, router]);

  if (!over) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-background/85 p-8 backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-primary px-16 py-14 text-center">
        <Upload className="size-10 text-primary" />
        <div>
          <p className="text-lg font-semibold">Drop to deploy</p>
          <p className="mt-1 text-sm text-muted-foreground">
            .tar.gz, .tgz, .tar or .zip
          </p>
        </div>
      </div>
    </div>
  );
}

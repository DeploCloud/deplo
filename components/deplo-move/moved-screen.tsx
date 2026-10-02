import { ExternalLink, Truck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DocsLink } from "@/components/ui/docs-link";

// Replaces the whole dashboard once this Deplo has moved: nothing here answers to it any more.
export function MovedScreen({ url }: { url: string | null }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-info-wash">
            <Truck className="size-5 text-info" />
          </div>
          <CardTitle>This Deplo moved</CardTitle>
          <CardDescription>
            Your apps, servers and settings now live on the new Deplo. Sign in
            there with the same account. <DocsLink topic="deplo.move" />
          </CardDescription>
        </CardHeader>
        {url && (
          <CardContent>
            <Button asChild className="w-full">
              <a href={url}>
                Open {url.replace(/^https?:\/\//, "")}
                <ExternalLink className="size-4" />
              </a>
            </Button>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

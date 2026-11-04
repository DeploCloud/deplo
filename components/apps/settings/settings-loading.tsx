"use client";

import * as React from "react";
import { Bone } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const LoadingContext = React.createContext(false);

export function useSettingsLoading(): boolean {
  return React.useContext(LoadingContext);
}

// The real settings forms, drawn with placeholder props: inert, with every control as a bone.
export function SettingsLoading({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <LoadingContext.Provider value>
      <div
        inert
        aria-busy
        className={cn(
          "[&_:is([role=combobox],[role=switch])>*]:invisible [&_:is(input,textarea)]:placeholder:text-transparent! [&_:is(input,textarea,[role=combobox],[role=switch])]:animate-pulse [&_:is(input,textarea,[role=combobox],[role=switch])]:border-transparent! [&_:is(input,textarea,[role=combobox],[role=switch])]:bg-muted! [&_:is(input,textarea,[role=combobox],[role=switch])]:text-transparent! [&_:is(input,textarea,[role=combobox],[role=switch])]:shadow-none!",
          className,
        )}
      >
        {children}
      </div>
    </LoadingContext.Provider>
  );
}

/** Data-driven text inside a settings form: a bone while the page loads. */
export function LoadingText({ children }: { children: React.ReactNode }) {
  return <Bone loading={useSettingsLoading()}>{children}</Bone>;
}

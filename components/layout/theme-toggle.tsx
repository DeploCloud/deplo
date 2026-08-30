"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";

export function ThemeToggle() {
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- avoid theme hydration mismatch
    setMounted(true);
  }, []);

  const isDark = resolvedTheme === "dark";

  return (
    <SimpleTooltip content={isDark ? "Light mode" : "Dark mode"}>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setTheme(isDark ? "light" : "dark")}
        aria-label="Toggle theme"
      >
        {mounted ? (
          isDark ? (
            <Sun className="size-4" />
          ) : (
            <Moon className="size-4" />
          )
        ) : (
          <Sun className="size-4" />
        )}
      </Button>
    </SimpleTooltip>
  );
}

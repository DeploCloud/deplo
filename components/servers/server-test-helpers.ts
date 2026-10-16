import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { TooltipProvider } from "@/components/ui/tooltip";

const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "server-view-test",
};

export function renderServerView(child: ReactNode, query = "") {
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(
        PathnameContext.Provider,
        { value: "/customer/settings/servers/srv_one" },
        createElement(
          SearchParamsContext.Provider,
          { value: new URLSearchParams(query) },
          createElement(TooltipProvider, null, child),
        ),
      ),
    ),
  );
}

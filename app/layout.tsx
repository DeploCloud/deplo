import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ServerConnectionGuard } from "@/components/layout/server-connection-guard";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Overview - Deplo",
    template: "%s - Deplo",
  },
  icons: { icon: "/favicon.ico", apple: "/apple-icon.png" },
  appleWebApp: { capable: true, title: "Deplo", statusBarStyle: "black" },
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

// cover: the installed app draws to the screen edge, and the tab bar keeps clear of the home indicator.
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: "#000000",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // No inline bootstrap script: React 19.2 refuses to run scripts rendered through React, so the theme rides this cookie.
  const stored = (await cookies()).get("theme")?.value;
  const theme = stored === "light" ? "light" : "dark";

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full ${theme}`}
      style={{ colorScheme: theme }}
    >
      <body className="min-h-full bg-background text-foreground antialiased">
        <ThemeProvider defaultTheme={theme}>
          <TooltipProvider delayDuration={200}>
            {children}
            <Toaster
              position="bottom-right"
              offset={{ bottom: "var(--toast-bottom, 24px)" }}
              mobileOffset={{ bottom: "var(--toast-bottom, 16px)" }}
            />
            <ServerConnectionGuard />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
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
    default: "Deplo – Ship anything, anywhere",
    template: "%s – Deplo",
  },
  description:
    "Deplo is a self-hosted platform to deploy apps, databases and services with Docker and Traefik. The developer experience of Vercel, on your own servers.",
  icons: { icon: "/favicon.ico" },
  // Private operations panel: no page should ever be indexed. This renders
  // <meta name="robots" content="noindex, nofollow, ..."> on every route and
  // cascades to child pages. Reinforced by app/robots.ts and the
  // X-Robots-Tag response header (next.config.ts + proxy.ts).
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

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Zero-flash theming WITHOUT an inline bootstrap script (React 19.2 refuses to
  // run scripts rendered through React and warns): the client writes the resolved
  // theme to a `theme` cookie, and the server paints the matching <html> class
  // here on the next load. Defaults to dark when the cookie is absent.
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
            <Toaster position="bottom-right" />
            <ServerConnectionGuard />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

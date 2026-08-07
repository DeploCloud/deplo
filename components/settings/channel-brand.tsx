import * as React from "react";
import { Bell, Mail, Webhook } from "lucide-react";

import {
  DiscordIcon,
  MattermostIcon,
  MicrosoftTeamsIcon,
  NtfyIcon,
  SlackIcon,
  TelegramIcon,
} from "@/components/shared/brand-icons";
import { cn } from "@/lib/utils";
import type { NotificationChannel } from "@/lib/types";

/**
 * How each channel presents itself: its name, its one-line pitch, and its own
 * brand colour.
 *
 * The colour is the point. Twelve identical grey tiles are twelve things you
 * have to READ to tell apart; the brand colour makes the row you want findable
 * before you have parsed a single word.
 *
 * The marks are real (simple-icons, CC0). Lark, Gotify and Pushover publish no
 * clean single-path mark, so they carry a brand-coloured initial instead — an
 * initial is honest, a logo redrawn from memory is not.
 */
export interface ChannelBrand {
  label: string;
  /** One line, what the channel does. */
  description: string;
  beta?: boolean;
  /** Brand background. A literal, not a token: a brand colour is not themeable. */
  bg: string;
  /** Foreground on that background, picked for contrast. */
  fg: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Used when the brand has no mark we can render truthfully. */
  initial?: string;
}

export const CHANNEL_BRAND: Record<NotificationChannel, ChannelBrand> = {
  discord: {
    label: "Discord",
    description: "Posts into a channel through an incoming webhook.",
    bg: "#5865F2",
    fg: "#FFFFFF",
    icon: DiscordIcon,
  },
  slack: {
    label: "Slack",
    description: "Posts into a channel through an incoming webhook.",
    beta: true,
    bg: "#4A154B",
    fg: "#FFFFFF",
    icon: SlackIcon,
  },
  telegram: {
    label: "Telegram",
    description: "Sends to a chat through a bot you made with BotFather.",
    beta: true,
    bg: "#26A5E4",
    fg: "#FFFFFF",
    icon: TelegramIcon,
  },
  mattermost: {
    label: "Mattermost",
    description: "Posts into a channel through an incoming webhook.",
    beta: true,
    bg: "#0058CC",
    fg: "#FFFFFF",
    icon: MattermostIcon,
  },
  msteams: {
    label: "Microsoft Teams",
    description: "Posts into a channel through a Power Automate workflow.",
    beta: true,
    bg: "#6264A7",
    fg: "#FFFFFF",
    icon: MicrosoftTeamsIcon,
  },
  lark: {
    label: "Lark",
    description: "Posts into a group through a custom bot.",
    beta: true,
    bg: "#00D6B9",
    fg: "#04322C",
    initial: "L",
  },
  ntfy: {
    label: "ntfy",
    description: "Publishes to a topic on ntfy.sh or your own server.",
    beta: true,
    bg: "#338574",
    fg: "#FFFFFF",
    icon: NtfyIcon,
  },
  gotify: {
    label: "Gotify",
    description: "Pushes to your own Gotify server.",
    beta: true,
    bg: "#0D9488",
    fg: "#FFFFFF",
    initial: "G",
  },
  pushover: {
    label: "Pushover",
    description: "Pushes to your phone through Pushover.",
    beta: true,
    bg: "#249DF1",
    fg: "#FFFFFF",
    initial: "P",
  },
  email: {
    label: "Email",
    description: "Through your own SMTP server or a Resend key.",
    bg: "#DC2626",
    fg: "#FFFFFF",
    icon: Mail,
  },
  webhook: {
    label: "Webhook",
    description: "POSTs a small JSON body to any URL you own.",
    bg: "#059669",
    fg: "#FFFFFF",
    icon: Webhook,
  },
  push: {
    label: "Browser push",
    description: "Desktop notifications on the devices you turn on.",
    beta: true,
    bg: "#7C3AED",
    fg: "#FFFFFF",
    icon: Bell,
  },
};

/** The brand tile: the mark on its own colour, or the initial when there is none. */
export function ChannelMark({
  channel,
  className,
  iconClassName,
}: {
  channel: NotificationChannel;
  className?: string;
  iconClassName?: string;
}) {
  const brand = CHANNEL_BRAND[channel];
  const Icon = brand.icon;
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg",
        className,
      )}
      style={{ backgroundColor: brand.bg, color: brand.fg }}
    >
      {Icon ? (
        <Icon className={cn("size-4.5", iconClassName)} />
      ) : (
        <span className={cn("text-sm font-semibold leading-none", iconClassName)}>
          {brand.initial}
        </span>
      )}
    </span>
  );
}

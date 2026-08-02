"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { CircleHelp } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../ui/utils";

type TooltipSide = "top" | "right" | "bottom" | "left";
type TooltipAlign = "start" | "center" | "end";

type GuidanceTooltipProps = {
  content?: ReactNode;
  children: ReactElement;
  side?: TooltipSide;
  align?: TooltipAlign;
  className?: string;
  disabled?: boolean;
};

export function GuidanceTooltip({
  content,
  children,
  side = "top",
  align = "center",
  className,
  disabled = false,
}: GuidanceTooltipProps) {
  if (!content || disabled) return children;

  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={100}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={7}
            collisionPadding={12}
            className={cn(
              "z-[100] max-w-[18rem] rounded-md bg-[#111827] px-2.5 py-1.5 text-center text-[0.6875rem] font-semibold leading-snug text-white shadow-[0_10px_30px_rgba(15,23,42,0.22)]",
              className,
            )}
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-[#111827]" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function InlineHelpTooltip({ content, className }: { content: ReactNode; className?: string }) {
  return (
    <GuidanceTooltip content={content}>
      <button
        type="button"
        className={cn(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#93c5fd] bg-[#eff6ff] text-[#1d4ed8] shadow-[0_1px_2px_rgba(37,99,235,0.12)] transition hover:border-[#60a5fa] hover:bg-[#dbeafe] focus:outline-none focus:ring-2 focus:ring-[#bfdbfe]",
          className,
        )}
        aria-label="Aide contextuelle"
      >
        <CircleHelp className="h-3.5 w-3.5" strokeWidth={2.4} />
      </button>
    </GuidanceTooltip>
  );
}

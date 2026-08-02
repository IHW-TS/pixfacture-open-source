"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PresenceState = "enter" | "exit";

type AnimatedPresenceOptions = {
  exitMs?: number;
  enterMs?: number;
  disabled?: boolean;
};

const DEFAULT_EXIT_MS = 180;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function useAnimatedPresence(open: boolean, opts: AnimatedPresenceOptions = {}) {
  const { exitMs = DEFAULT_EXIT_MS, disabled = false } = opts;
  const [present, setPresent] = useState(open);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearExitTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleChange = () => setPrefersReducedMotion(mediaQuery.matches);
    handleChange();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  const effectiveExitMs = disabled || prefersReducedMotion ? 0 : exitMs;

  useEffect(() => {
    clearExitTimer();

    if (open) {
      setPresent(true);
      return;
    }

    if (!present || effectiveExitMs <= 0) {
      setPresent(false);
      return;
    }

    timerRef.current = setTimeout(() => {
      setPresent(false);
      timerRef.current = null;
    }, effectiveExitMs);

    return clearExitTimer;
  }, [open, present, effectiveExitMs, clearExitTimer]);

  useEffect(() => clearExitTimer, [clearExitTimer]);

  const mounted = open || present;
  const state: PresenceState = open ? "enter" : "exit";

  const onAnimationEnd = useCallback(() => {
    if (!open) {
      clearExitTimer();
      setPresent(false);
    }
  }, [open, clearExitTimer]);

  return { mounted, state, shouldRender: mounted, onAnimationEnd };
}

/*
Usage:
const { mounted, state } = useAnimatedPresence(open);
if (!mounted) return null;
return <div className="modal-overlay ui-overlay" data-state={state}>...</div>;
*/

"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

const TARGET_SELECTOR = [
  ".marketing-main .mk-hero",
  ".marketing-main .page-hero",
  ".marketing-main .mk-quickline",
  ".marketing-main .mk-positioning-strip",
  ".marketing-main .pricing-notice",
  ".marketing-main .pricing-notices",
  ".marketing-main section",
  ".marketing-main .section",
  ".marketing-main .panel",
].join(", ");

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function resolveMotionKind(node: Element): "hero" | "strip" | "section" {
  if (node.matches(".mk-hero, .page-hero, .mk-dark-hero")) return "hero";
  if (node.matches(".mk-quickline, .mk-positioning-strip, .pricing-notice, .pricing-notices")) return "strip";
  return "section";
}

export default function MarketingMotionSystem() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const shell = document.querySelector<HTMLElement>(".marketing-shell");
    if (!shell) return;

    shell.setAttribute("data-motion-ready", "true");
    const routeKey = pathname === "/" ? "home" : (pathname || "").replace(/^\/+/, "").split("/")[0] || "home";
    shell.setAttribute("data-marketing-route", routeKey);

    const updateNavScrolled = () => {
      shell.setAttribute("data-nav-scrolled", window.scrollY > 24 ? "true" : "false");
    };

    updateNavScrolled();
    window.addEventListener("scroll", updateNavScrolled, { passive: true });

    const homeUsesReactMotion =
      pathname === "/" && !!document.querySelector("#mk-home-scope[data-motion-driver='react']");
    if (homeUsesReactMotion) {
      shell.setAttribute("data-motion-mode", "off");
      const staleTargets = document.querySelectorAll<HTMLElement>("#mk-home-scope [data-motion]");
      for (const target of staleTargets) {
        target.removeAttribute("data-motion");
        target.removeAttribute("data-motion-kind");
      }
      return () => {
        window.removeEventListener("scroll", updateNavScrolled);
        shell.removeAttribute("data-marketing-route");
        shell.removeAttribute("data-motion-mode");
      };
    }

    const allTargets = Array.from(document.querySelectorAll<HTMLElement>(TARGET_SELECTOR)).filter((node) =>
      node.closest(".marketing-main"),
    );
    const uniqueTargets = Array.from(new Set(allTargets));

    for (const target of uniqueTargets) {
      target.setAttribute("data-motion-kind", resolveMotionKind(target));
      if (target.getAttribute("data-motion") !== "in") {
        target.setAttribute("data-motion", "pending");
      }
    }

    const params = new URLSearchParams(window.location.search);
    const motionParam = params.get("motion");
    const forceMotion = motionParam === "force";
    const disableMotion = motionParam === "off";
    const prefersReducedMotion =
      !forceMotion && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;

    shell.setAttribute("data-motion-mode", forceMotion ? "force" : disableMotion ? "off" : "auto");

    if (prefersReducedMotion || disableMotion) {
      for (const target of uniqueTargets) {
        target.setAttribute("data-motion", "in");
      }
      return () => {
        window.removeEventListener("scroll", updateNavScrolled);
        shell.removeAttribute("data-marketing-route");
        shell.removeAttribute("data-motion-mode");
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const element = entry.target as HTMLElement;
          element.setAttribute("data-motion", "in");
          observer.unobserve(element);
        }
      },
      { threshold: 0.06, rootMargin: "0px 0px -6% 0px" },
    );

    const visibleTargets: HTMLElement[] = [];
    let rafA = 0;
    let rafB = 0;
    let scrollRaf = 0;
    let fallbackTimer = 0;

    const promotePendingTargets = () => {
      for (const target of uniqueTargets) {
        if (target.getAttribute("data-motion") === "in") continue;
        const rect = target.getBoundingClientRect();
        // If a section has already passed above the viewport or is close to entering it,
        // we force it to "in" to avoid permanent hidden gaps on fast scroll/navigation.
        if (rect.bottom < 0 || rect.top <= window.innerHeight - 24) {
          target.setAttribute("data-motion", "in");
          observer.unobserve(target);
        }
      }
    };

    for (const target of uniqueTargets) {
      const rect = target.getBoundingClientRect();
      if (rect.top <= window.innerHeight * 0.94) {
        visibleTargets.push(target);
      } else {
        observer.observe(target);
      }
    }

    // Ensure "pending" state is actually painted before switching to "in".
    // Without this frame split, browsers can batch style updates and skip the transition.
    rafA = window.requestAnimationFrame(() => {
      rafB = window.requestAnimationFrame(() => {
        for (const target of visibleTargets) {
          target.setAttribute("data-motion", "in");
        }
        promotePendingTargets();
      });
    });

    const onScrollOrResize = () => {
      if (scrollRaf) return;
      scrollRaf = window.requestAnimationFrame(() => {
        scrollRaf = 0;
        promotePendingTargets();
      });
    };

    window.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);

    // Safety net: even if the observer misses an entry (very fast scroll / browser edge),
    // never keep content hidden for more than a short moment.
    fallbackTimer = window.setTimeout(() => {
      for (const target of uniqueTargets) {
        if (target.getAttribute("data-motion") !== "in") {
          target.setAttribute("data-motion", "in");
          observer.unobserve(target);
        }
      }
    }, 2400);

    return () => {
      observer.disconnect();
      if (rafA) window.cancelAnimationFrame(rafA);
      if (rafB) window.cancelAnimationFrame(rafB);
      if (scrollRaf) window.cancelAnimationFrame(scrollRaf);
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      window.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", updateNavScrolled);
      shell.removeAttribute("data-marketing-route");
      shell.removeAttribute("data-motion-mode");
    };
  }, [pathname]);

  return null;
}

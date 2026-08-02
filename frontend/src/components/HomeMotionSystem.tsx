"use client";

import { useEffect } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const HOME_ROOT_SELECTOR = "#mk-home-scope[data-motion-driver='react']";
const TARGET_SELECTOR = [
  ".mk-dark-hero__copy > *",
  ".mk-dark-hero__media > *",
  ".mk-dark-hero__metrics > article",
  ".fgm-section__head > *",
  ".fgm-card",
  ".fgm-step-card",
  ".fgm-tech-item",
  ".fgm-product-block",
  ".fgm-faq-item",
  ".fgm-cta-box",
  ".fgm-footer-top > *",
  ".fgm-footer-note",
  ".fgm-footer-bottom > *",
].join(", ");

function shouldAnimateImmediately(node: HTMLElement): boolean {
  return !!node.closest(".mk-dark-hero");
}

function inViewport(node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect();
  return rect.top <= window.innerHeight * 0.92;
}

export default function HomeMotionSystem() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = document.querySelector<HTMLElement>(HOME_ROOT_SELECTOR);
    if (!root) return;

    const shell = document.querySelector<HTMLElement>(".marketing-shell");
    if (shell) {
      shell.setAttribute("data-home-motion-driver", "react");
    }

    root.setAttribute("data-bmotion-ready", "true");
    const targets = Array.from(root.querySelectorAll<HTMLElement>(TARGET_SELECTOR)).filter(
      (node) => !node.hasAttribute("data-bmotion-ignore"),
    );

    for (const [index, node] of targets.entries()) {
      node.setAttribute("data-bmotion", shouldAnimateImmediately(node) ? "hero" : "section");
      node.setAttribute("data-bmotion-state", "pending");
      node.setAttribute("data-bmotion-order", String(index % 7));
    }

    const params = new URLSearchParams(window.location.search);
    const motionParam = params.get("motion");
    const forceMotion = motionParam === "force";
    const disableMotion = motionParam === "off";
    const prefersReducedMotion =
      !forceMotion && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
    if (prefersReducedMotion || disableMotion) {
      for (const node of targets) {
        node.setAttribute("data-bmotion-state", "in");
      }
      return () => {
        root.removeAttribute("data-bmotion-ready");
        if (shell) shell.removeAttribute("data-home-motion-driver");
      };
    }

    const visibleNow: HTMLElement[] = [];
    const delayed: HTMLElement[] = [];
    for (const node of targets) {
      if (shouldAnimateImmediately(node) || inViewport(node)) {
        visibleNow.push(node);
      } else {
        delayed.push(node);
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const node = entry.target as HTMLElement;
          node.setAttribute("data-bmotion-state", "in");
          observer.unobserve(node);
        }
      },
      { threshold: 0.16, rootMargin: "0px 0px -10% 0px" },
    );

    for (const node of delayed) {
      observer.observe(node);
    }

    let rafA = 0;
    let rafB = 0;
    let fallbackTimer = 0;

    // Two RAFs to guarantee the browser paints the "pending" state first.
    rafA = window.requestAnimationFrame(() => {
      rafB = window.requestAnimationFrame(() => {
        for (const node of visibleNow) {
          node.setAttribute("data-bmotion-state", "in");
        }
      });
    });

    fallbackTimer = window.setTimeout(() => {
      for (const node of targets) {
        if (node.getAttribute("data-bmotion-state") !== "in") {
          node.setAttribute("data-bmotion-state", "in");
          observer.unobserve(node);
        }
      }
    }, 3000);

    return () => {
      observer.disconnect();
      if (rafA) window.cancelAnimationFrame(rafA);
      if (rafB) window.cancelAnimationFrame(rafB);
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      root.removeAttribute("data-bmotion-ready");
      if (shell) shell.removeAttribute("data-home-motion-driver");
    };
  }, []);

  return null;
}

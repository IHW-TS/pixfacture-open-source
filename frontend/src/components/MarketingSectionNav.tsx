"use client";

import { useEffect, useState } from "react";

const SECTIONS = [
  { id: "hero", label: "Accueil" },
  { id: "features", label: "Fonctionnalités" },
  { id: "pricing", label: "Tarifs" },
  { id: "reform", label: "Réforme 2026" },
  { id: "faq", label: "FAQ" },
];

export default function MarketingSectionNav() {
  const [activeId, setActiveId] = useState("hero");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onScroll = () => setVisible(window.scrollY > 300);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const observers: IntersectionObserver[] = [];

    for (const section of SECTIONS) {
      const element = document.getElementById(section.id);
      if (!element) continue;

      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) setActiveId(section.id);
        },
        { threshold: 0.4, rootMargin: "-10% 0px -10% 0px" },
      );

      observer.observe(element);
      observers.push(observer);
    }

    return () => observers.forEach((observer) => observer.disconnect());
  }, []);

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav className={`fgm-section-nav ${visible ? "is-visible" : ""}`} aria-label="Navigation des sections">
      {SECTIONS.map((section) => {
        const isActive = activeId === section.id;
        return (
          <button
            key={section.id}
            type="button"
            className="fgm-section-nav__item"
            data-active={isActive ? "true" : "false"}
            onClick={() => scrollToSection(section.id)}
            aria-label={section.label}
            title={section.label}
          >
            <span className="fgm-section-nav__label">{section.label}</span>
            <span className="fgm-section-nav__dot" aria-hidden="true" />
          </button>
        );
      })}
    </nav>
  );
}

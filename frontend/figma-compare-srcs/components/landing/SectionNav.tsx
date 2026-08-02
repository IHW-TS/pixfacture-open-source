import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";

const sections = [
  { id: "hero", label: "Accueil" },
  { id: "features", label: "Fonctionnalités" },
  { id: "pricing", label: "Tarifs" },
  { id: "reform", label: "Réforme 2026" },
  { id: "faq", label: "FAQ" },
];

export function SectionNav() {
  const [activeId, setActiveId] = useState("hero");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setVisible(window.scrollY > 300);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const observers: IntersectionObserver[] = [];

    sections.forEach((section) => {
      const el = document.getElementById(section.id);
      if (!el) return;

      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) setActiveId(section.id);
        },
        { threshold: 0.4, rootMargin: "-10% 0px -10% 0px" }
      );
      observer.observe(el);
      observers.push(observer);
    });

    return () => observers.forEach((o) => o.disconnect());
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 16 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="fixed right-5 top-1/2 -translate-y-1/2 z-40 hidden lg:flex flex-col gap-3 items-end"
        >
          {sections.map((section) => {
            const isActive = activeId === section.id;
            return (
              <motion.button
                key={section.id}
                onClick={() => scrollTo(section.id)}
                className="relative flex items-center gap-2.5 border-none bg-transparent cursor-pointer p-1 group"
                title={section.label}
                whileHover="hovered"
                initial="idle"
                animate="idle"
              >
                {/* Tooltip label */}
                <motion.span
                  className="text-[11px] font-medium text-white px-2.5 py-1 rounded-lg whitespace-nowrap"
                  style={{
                    background: "rgba(7,13,26,0.9)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    backdropFilter: "blur(8px)",
                  }}
                  variants={{
                    idle: { opacity: 0, x: 8, scale: 0.96 },
                    hovered: { opacity: 1, x: 0, scale: 1 },
                  }}
                  transition={{ duration: 0.2 }}
                >
                  {section.label}
                </motion.span>

                {/* Dot */}
                <motion.div
                  className="rounded-full shrink-0"
                  animate={{
                    width: isActive ? 10 : 6,
                    height: isActive ? 10 : 6,
                    backgroundColor: isActive ? "#3b82f6" : "rgba(255,255,255,0.2)",
                    boxShadow: isActive ? "0 0 8px rgba(59,130,246,0.7)" : "none",
                  }}
                  whileHover={{ scale: 1.5 }}
                  transition={{ type: "spring", stiffness: 400, damping: 20 }}
                />

                {/* Active ring */}
                {isActive && (
                  <motion.div
                    layoutId="section-nav-ring"
                    className="absolute right-1 rounded-full border border-blue-400/40"
                    style={{ width: 18, height: 18 }}
                    transition={{ type: "spring", stiffness: 400, damping: 28 }}
                  />
                )}
              </motion.button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

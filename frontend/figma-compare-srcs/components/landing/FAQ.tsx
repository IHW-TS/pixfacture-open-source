import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Plus, Minus, HelpCircle } from "lucide-react";
import { AnimatedSection, AnimatedStagger, AnimatedStaggerItem } from "./AnimatedSection";

const faqs = [
  {
    q: "Factur‑X, c'est quoi exactement ?",
    a: "Un PDF/A-3b avec des données structurées XML/CII embarquées (format mixte). Il combine la lisibilité d'un PDF et les données structurées requises pour la transmission réglementaire et le traitement automatisé.",
  },
  {
    q: "Êtes‑vous une plateforme agréée (PA, ex‑PDP) ?",
    a: "Non. Nous sommes un logiciel de facturation B2B. La transmission réglementaire se fait via une plateforme agréée (PA) sous contrat/mandat que vous activez. Nous ne sommes pas immatriculés comme PA.",
  },
  {
    q: "Comment fonctionne le connecteur vers une plateforme agréée ?",
    a: "Le plan Pro peut être connecté à une PA via un connecteur partenaire (selon disponibilité). L'app guide la préparation du mandat selon contrat, configuration et disponibilité du connecteur. Aucun identifiant technique côté client.",
  },
  {
    q: "Y a‑t‑il un essai gratuit ?",
    a: "Oui. Vous pouvez démarrer en mode export (Factur‑X/PDF/CSV) sans engagement. Consultez la page tarifs pour les détails de chaque plan et les conditions d'activation du mode connecté.",
  },
  {
    q: "Puis‑je changer de plan plus tard ?",
    a: "Oui. Vous pouvez passer d'un plan à l'autre selon vos besoins (volume, multi‑utilisateurs, connecteurs). La montée en plan active les fonctionnalités sans perte de données.",
  },
  {
    q: "Quelles données dois-je collecter dès maintenant ?",
    a: "Pour la réforme 2026-2027 : SIREN/SIRET, adresse, TVA, nature de l'opération, adresse de livraison si différente, option TVA sur les débits (si applicable), selon les spécifications DGFiP en vigueur.",
  },
  {
    q: "Quels formats de facture sont pris en charge ?",
    a: "PDF, Factur‑X (PDF/A-3b + XML/CII), UBL et CII selon le plan. Nous suivons les spécifications officielles DGFiP et mettons à jour les contrôles au fil des évolutions réglementaires.",
  },
  {
    q: "Le service constitue-t-il un conseil fiscal ou juridique ?",
    a: "Non. Le service ne constitue pas un conseil fiscal/juridique. Les informations sur la réforme sont fournies à titre informatif et peuvent évoluer. Références : spécifications externes B2B / calendrier officiel DGFiP.",
  },
];

function FAQItem({ faq, index }: { faq: typeof faqs[0]; index: number }) {
  const [open, setOpen] = useState(false);

  return (
    <AnimatedStaggerItem>
      <motion.div
        className="rounded-2xl overflow-hidden bg-white"
        style={{ border: "1px solid #e2e8f0" }}
        animate={{
          borderColor: open ? "rgba(59,130,246,0.4)" : "#e2e8f0",
          boxShadow: open ? "0 8px 32px rgba(29,78,216,0.08)" : "0 1px 3px rgba(0,0,0,0.02)",
        }}
        transition={{ duration: 0.25 }}
      >
        <button
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between gap-4 p-5 md:p-6 text-left bg-transparent border-none cursor-pointer group"
        >
          <div className="flex items-start gap-4">
            <span className="text-[12px] font-bold text-blue-500/60 mt-0.5 shrink-0 font-mono">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="text-[15px] font-semibold text-slate-900 leading-snug group-hover:text-blue-700 transition-colors">
              {faq.q}
            </span>
          </div>
          <motion.div
            animate={{ rotate: open ? 45 : 0 }}
            transition={{ duration: 0.2 }}
            className={`shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all ${
              open
                ? "bg-blue-600 text-white"
                : "bg-slate-100 text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-600"
            }`}
          >
            <Plus size={14} />
          </motion.div>
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <p className="px-5 md:px-6 pb-5 md:pb-6 text-[14px] text-slate-500 leading-[1.8] pl-[52px] md:pl-[72px]">
                {faq.a}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatedStaggerItem>
  );
}

export function FAQ() {
  return (
    <section id="faq" className="py-24 md:py-32"
      style={{ background: "linear-gradient(180deg, #070d1a 0%, #0a1628 100%)" }}>
      <div className="max-w-[860px] mx-auto px-6">

        <AnimatedSection className="text-center mb-14">
          <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-400 mb-4">FAQ</span>
          <h2 className="text-[36px] md:text-[48px] font-bold text-white leading-[1.1] tracking-tight">
            Questions fréquentes
          </h2>
          <p className="mt-5 text-[17px] max-w-md mx-auto leading-relaxed" style={{ color: "rgba(148,163,184,1)" }}>
            Tout ce qu'il faut savoir avant de démarrer ou de choisir votre plan.
          </p>
        </AnimatedSection>

        <AnimatedStagger className="flex flex-col gap-3">
          {faqs.map((faq, i) => (
            <FAQItem key={i} faq={faq} index={i} />
          ))}
        </AnimatedStagger>

        <AnimatedSection delay={0.4} className="mt-12 text-center">
          <div className="inline-flex flex-col items-center gap-3 px-8 py-6 rounded-2xl"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <HelpCircle size={24} className="text-blue-400" />
            <p className="text-[14px] font-medium text-white">Vous avez une autre question ?</p>
            <a href="/contact"
              className="inline-flex items-center gap-2 text-[13px] font-semibold text-blue-400 hover:text-blue-300 transition-colors">
              Parler à un expert →
            </a>
            <p className="text-[11px] mt-1" style={{ color: "rgba(71,85,105,1)" }}>
              Informations fournies à titre informatif ·{" "}
              <a href="https://www.impots.gouv.fr/specifications-externes-b2b" target="_blank" rel="noopener noreferrer"
                className="text-blue-500 hover:underline">Sources DGFiP</a>
            </p>
          </div>
        </AnimatedSection>
      </div>
    </section>
  );
}

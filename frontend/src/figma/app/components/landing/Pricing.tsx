"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, Minus, Sparkles, ArrowRight, Zap } from "lucide-react";
import { AnimatedSection, AnimatedStagger, AnimatedStaggerItem, Tilt3DCard } from "./AnimatedSection";
import { Link } from "@/figma/react-router-compat";

const plans = [
  {
    name: "Starter",
    tagline: "Facturation classique",
    monthly: "29",
    annual: "290",
    desc: "Facturation classique pour TPE/PME : clients, devis, factures PDF et branding de base. Achats, paiements et e-facturation restent réservés au plan Pro.",
    cta: "Choisir Starter",
    ctaHref: "/app/register",
    featured: false,
    features: [
      { text: "Clients, devis et factures", included: true },
      { text: "1 société / 1 utilisateur", included: true },
      { text: "PDF professionnels", included: true },
      { text: "Branding de base", included: true },
      { text: "Dashboard et paramètres", included: true },
      { text: "Achats et paiements réservés au plan Pro", included: false },
      { text: "E-facturation réservée au plan Pro", included: false },
    ],
  },
  {
    name: "Pro",
    tagline: "Facturation + préparation e-facturation",
    monthly: "59",
    annual: "590",
    desc: "Facturation, achats, paiements et préparation e-facturation. Les transmissions exigent contrat, mandat et connecteur opérationnel. Les 50 jetons sont réservés à la souscription, puis crédités après activation et disponibilité du stock.",
    cta: "Voir l'offre Pro",
    ctaHref: "/pricing",
    featured: true,
    badge: "Recommandé",
    features: [
      { text: "Tout Starter inclus", included: true },
      { text: "1 société / jusqu'à 3 utilisateurs", included: true },
      { text: "Achats fournisseurs et suivi des paiements", included: true },
      { text: "Préparation Chorus Pro B2G ; activation uniquement si configuré", included: true },
      { text: "Connecteur PA selon contrat, mandat et activation opérationnelle", included: true },
      { text: "E-facturation activable selon configuration", included: true },
      { text: "50 jetons réservés, puis crédités après activation et disponibilité du stock", included: true },
      { text: "Packs disponibles après activation opérationnelle", included: true },
      { text: "Multi‑utilisateurs + rôles", included: true },
      { text: "Configuration et onboarding connecteur sous conditions", included: true },
      { text: "SSO/SCIM", included: false },
    ],
  },
  {
    name: "Volume",
    tagline: "Intégrations & volumes",
    monthly: null,
    annual: null,
    desc: "Périmètre, volume, intégrations sur mesure.",
    cta: "Demander un devis",
    ctaHref: "/contact",
    featured: false,
    features: [
      { text: "Tout Pro inclus", included: true },
      { text: "Intégrations ERP / SI", included: true },
      { text: "Audit export & journaux", included: true },
      { text: "Support prioritaire dédié", included: true },
      { text: "SSO/SCIM sur demande, selon contrat", included: true },
      { text: "Accompagnement ERP", included: true },
      { text: "SLA dédié négocié", included: true },
      { text: "Volumes sur mesure", included: true },
    ],
  },
];

const complianceItems = [
  { text: "Factur‑X / EN16931 (CII) : génération + contrôles selon configuration", icon: "✓" },
  { text: "E-facturation Pro selon contrat, mandat et configuration du connecteur", icon: "✓" },
  { text: "50 jetons réservés, puis crédités après activation et disponibilité du stock", icon: "✓" },
  {
    text: "Packs : 100 = 29 € · 500 = 129 € · 1000 = 249 € · 5000 = 1199 €, après activation opérationnelle",
    icon: "✓",
  },
  { text: "E‑reporting : export Pro, PA selon activation", icon: "⟳" },
  { text: "Préparation des connecteurs sur Pro ; activation sous contrat, mandat et configuration", icon: "✓" },
];

export function Pricing() {
  const [annual, setAnnual] = useState(false);

  return (
    <section id="pricing" className="py-24 md:py-32 bg-white">
      <div className="max-w-[1240px] mx-auto px-6 md:px-8">
        <AnimatedSection className="mb-14 flex flex-col items-center text-center">
          <div className="mx-auto flex w-full max-w-[820px] flex-col items-center gap-6">
            <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] leading-none text-blue-700">
              Tarifs
            </span>
            <h2 className="max-w-[800px] text-4xl font-bold tracking-tight text-slate-900 md:text-5xl leading-[1.08]">
              Plans adaptés à votre volume
            </h2>
            <p className="max-w-[760px] text-[17px] leading-relaxed text-slate-600">
              Évoluez de Starter à Pro sans perdre vos données ni reconfigurer votre flux de facturation.
            </p>
          </div>

          {/* Toggle */}
          <div
            className="mt-6 inline-flex items-center gap-1 rounded-2xl p-1.5"
            style={{ background: "#f1f5f9", border: "1px solid #e2e8f0" }}
          >
            <button
              type="button"
              onClick={() => setAnnual(false)}
              aria-pressed={!annual}
              className={`px-5 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 cursor-pointer border-none ${
                !annual ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 bg-transparent"
              }`}
            >
              Mensuel
            </button>
            <button
              type="button"
              onClick={() => setAnnual(true)}
              aria-pressed={annual}
              className={`px-5 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 cursor-pointer border-none flex items-center gap-2 ${
                annual ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 bg-transparent"
              }`}
            >
              Annuel
              <AnimatePresence>
                {annual && (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.7 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.7 }}
                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                    style={{ background: "linear-gradient(135deg, #047857, #065f46)", color: "white" }}
                  >
                    −2 mois
                  </motion.span>
                )}
              </AnimatePresence>
              {!annual && (
                <span className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-medium">
                  économisez
                </span>
              )}
            </button>
          </div>
        </AnimatedSection>

        <AnimatedStagger className="mx-auto grid w-full max-w-[1240px] gap-6 md:grid-cols-3">
          {plans.map((plan) => {
            const planHref =
              plan.name === "Starter"
                ? `/app/register?plan=starter&period=${annual ? "yearly" : "monthly"}`
                : plan.ctaHref;

            return (
              <AnimatedStaggerItem key={plan.name}>
                <Tilt3DCard intensity={5} className="h-full">
                  <div className="relative h-full">
                    {/* Animated glow border for featured plan */}
                    {plan.featured && (
                      <motion.div
                        className="absolute -inset-[1.5px] rounded-3xl pointer-events-none -z-10"
                        style={{
                          background: "linear-gradient(135deg, #1d4ed8, #60a5fa, #818cf8, #60a5fa, #1d4ed8)",
                        }}
                        animate={{ opacity: [0.5, 1, 0.5] }}
                        transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
                      />
                    )}
                    <motion.div
                      className={`relative rounded-3xl p-8 flex flex-col gap-6 h-full ${plan.featured ? "" : "bg-white"}`}
                      style={
                        plan.featured
                          ? {
                              background: "linear-gradient(160deg, #0f1e36 0%, #1e3a8a 50%, #1d4ed8 100%)",
                              boxShadow: "0 32px 80px rgba(29,78,216,0.3)",
                            }
                          : {
                              border: "1px solid #e2e8f0",
                              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                            }
                      }
                      whileHover={{
                        y: plan.featured ? -8 : -5,
                        boxShadow: plan.featured ? "0 48px 100px rgba(29,78,216,0.35)" : "0 24px 64px rgba(0,0,0,0.1)",
                      }}
                      transition={{ type: "spring", stiffness: 280, damping: 20 }}
                    >
                      {/* Popular badge */}
                      {plan.featured && plan.badge && (
                        <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                          <span
                            className="inline-flex items-center gap-1.5 text-[12px] font-bold px-4 py-1.5 rounded-full whitespace-nowrap"
                            style={{
                              background: "linear-gradient(135deg, #f59e0b, #fbbf24)",
                              color: "#451a03",
                              boxShadow: "0 4px 12px rgba(245,158,11,0.4)",
                            }}
                          >
                            <Sparkles size={12} /> {plan.badge}
                          </span>
                        </div>
                      )}

                      {/* Plan header */}
                      <div className="flex flex-col gap-4">
                        <div className="space-y-3">
                          <p
                            className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${plan.featured ? "text-blue-100" : "text-slate-600"}`}
                          >
                            {plan.tagline}
                          </p>
                          <h3
                            className={`text-[22px] font-bold leading-tight tracking-[-0.02em] ${plan.featured ? "text-white" : "text-slate-900"}`}
                          >
                            {plan.name}
                          </h3>
                        </div>

                        <div className="space-y-3">
                          <div className="flex items-end gap-1.5">
                            <AnimatePresence mode="wait">
                              <motion.span
                                key={annual ? "a" : "m"}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                transition={{ duration: 0.2 }}
                                className={`text-[44px] font-bold tracking-tight leading-none ${plan.featured ? "text-white" : "text-slate-900"}`}
                              >
                                {plan.monthly ? `${annual ? plan.annual : plan.monthly}€` : "Sur devis"}
                              </motion.span>
                            </AnimatePresence>
                            {plan.monthly && (
                              <span
                                className={`text-[14px] mb-1.5 ${plan.featured ? "text-blue-100" : "text-slate-600"}`}
                              >
                                /{annual ? "an" : "mois"}
                              </span>
                            )}
                          </div>
                          <p
                            className={`text-[13px] leading-[1.7] ${plan.featured ? "text-blue-200" : "text-slate-600"}`}
                          >
                            {plan.desc}
                          </p>
                        </div>
                      </div>

                      {plan.monthly && (
                        <ul className="flex flex-col gap-2.5 flex-1">
                          {plan.features.map((f, j) => (
                            <li key={j} className="flex items-center gap-2.5 text-[13px]">
                              {f.included ? (
                                <div
                                  className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${plan.featured ? "bg-blue-500/30" : "bg-blue-50"}`}
                                >
                                  <Check size={11} className={plan.featured ? "text-blue-200" : "text-blue-600"} />
                                </div>
                              ) : (
                                <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 bg-slate-100">
                                  <Minus size={10} className={plan.featured ? "text-blue-200" : "text-slate-600"} />
                                </div>
                              )}
                              <span
                                className={
                                  f.included
                                    ? plan.featured
                                      ? "text-blue-100"
                                      : "text-slate-700"
                                    : plan.featured
                                      ? "text-blue-200 line-through decoration-blue-300"
                                      : "text-slate-600 line-through decoration-slate-400"
                                }
                              >
                                {f.text}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {!plan.monthly && <div className="flex-1" />}

                      {/* CTA */}
                      <motion.a
                        href={planHref}
                        className={`w-full py-3.5 rounded-2xl text-[14px] font-semibold cursor-pointer border-none text-center block transition-all ${
                          plan.featured ? "bg-white text-blue-700 hover:bg-blue-50" : "text-white"
                        }`}
                        style={!plan.featured ? { background: "linear-gradient(135deg, #1d4ed8, #2563eb)" } : {}}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.97 }}
                      >
                        {plan.cta}
                      </motion.a>
                    </motion.div>
                  </div>
                </Tilt3DCard>
              </AnimatedStaggerItem>
            );
          })}
        </AnimatedStagger>

        {/* Compliance coverage */}
        <AnimatedSection delay={0.3} className="mx-auto mt-10 w-full max-w-[1240px]">
          <div className="rounded-2xl p-7 bg-white" style={{ border: "1px solid #e2e8f0" }}>
            <div className="flex items-center gap-3 mb-5">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: "linear-gradient(135deg, #1d4ed8, #3b82f6)" }}
              >
                <Zap size={14} className="text-white" />
              </div>
              <span className="text-[13px] font-bold text-slate-900 uppercase tracking-wider">
                Préparation réforme 2026–2027
              </span>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              {complianceItems.map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={`text-[13px] font-bold shrink-0 ${item.icon === "✓" ? "text-emerald-700" : "text-amber-700"}`}
                  >
                    {item.icon}
                  </span>
                  <span className="text-[13px] text-slate-600">{item.text}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-600 mt-5 pt-4" style={{ borderTop: "1px solid #f1f5f9" }}>
              PA = plateforme agréée (ex‑PDP). La transmission réglementaire s'effectue via une PA sous contrat/mandat.
              Nous ne sommes pas une PA immatriculée.
            </p>
          </div>
        </AnimatedSection>

        <AnimatedSection
          delay={0.4}
          className="mx-auto mt-6 flex w-full max-w-[1240px] flex-col items-center justify-between gap-4 sm:flex-row"
        >
          <p className="text-[13px] text-slate-600">
            Déjà client ?{" "}
            <a href="/app/login" className="text-blue-600 font-medium hover:underline">
              Se connecter
            </a>{" "}
            ·{" "}
            <Link to="/pricing" className="text-blue-600 font-medium hover:underline">
              Comparer toutes les fonctionnalités
            </Link>
          </p>
          <a
            href="/contact"
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-blue-600 hover:text-blue-700"
          >
            Cas particulier ? Parler à un expert <ArrowRight size={13} />
          </a>
        </AnimatedSection>
      </div>
    </section>
  );
}

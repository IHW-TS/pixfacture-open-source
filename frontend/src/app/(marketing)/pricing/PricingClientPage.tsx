"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Minus,
  Sparkles,
  Zap,
} from "lucide-react";
import { Calendar2026Block } from "@/components/Calendar2026Block";
import ComplianceClaimInline from "@/components/ComplianceClaimInline";
import OfficialPdpStatusNote from "@/components/OfficialPdpStatusNote";
import { PRICING_COPY } from "@/data/pricingCopy";
import { TRIAL_DAYS } from "@/lib/billingConstants";
import {
  complianceTimeline,
  formatIsoDateShortFr,
  formatYearRange,
  sourcesLastUpdatedAvailable,
  sourcesLastUpdatedLabel,
} from "@/lib/complianceTimeline";
import {
  fetchBillingStatus,
  fetchPublicPlansPricing,
  findPlan,
  formatAmountDisplay,
  type BillingPlan,
  type BillingPlanId,
  type BillingPlanPeriod,
  type BillingStatus,
  type PricingSource,
} from "@/lib/billingApi";
import { featureFlags } from "@/lib/featureFlags";
import { OFFICIAL_B2B_SPECS_URL, OFFICIAL_CALENDAR_URL, OFFICIAL_PDP_LIST_URL } from "@/lib/officialLinks";
import { EXPLANATION } from "@/lib/terminology";
import { hasHadSession } from "@/lib/sessionFlags";
import { useSession } from "@/lib/useSession";
import {
  partnerNameLabel,
  resolveMarketingClaimLevel,
  shouldShowPartneredMessaging,
  useComplianceMarketingStatus,
} from "@/lib/einvoicingMarketing";

type PlanFeature = {
  text: string;
  included: boolean;
};

type MarketingPlan = {
  id: BillingPlanId | "enterprise";
  name: string;
  yearlyName?: string;
  tagline: string;
  description: string;
  yearlyDescription?: string;
  cta: string;
  featured: boolean;
  badge?: string;
  features: PlanFeature[];
};

type ComparisonRow = {
  label: string;
  starter: string;
  pro: string;
  enterprise: string;
};

const CALENDAR_RANGE = formatYearRange(
  complianceTimeline.einvoicing.reception,
  complianceTimeline.einvoicing.emission_pme_micro,
  "-",
);
const RECEPTION_DATE_SHORT = formatIsoDateShortFr(complianceTimeline.einvoicing.reception);
const EMISSION_GE_ETI_DATE_SHORT = formatIsoDateShortFr(complianceTimeline.einvoicing.emission_ge_eti);
const EMISSION_PME_DATE_SHORT = formatIsoDateShortFr(complianceTimeline.einvoicing.emission_pme_micro);
const LAST_UPDATED = sourcesLastUpdatedAvailable ? sourcesLastUpdatedLabel : "";
const IS_NON_PROD = process.env.NODE_ENV !== "production";

const plans: MarketingPlan[] = [
  {
    id: "starter",
    name: "Starter",
    yearlyName: "Starter annuel",
    tagline: "Facturation",
    description:
      "Facturation classique pour TPE/PME : clients, devis, factures PDF et branding de base. Les achats, paiements et services d'e-facturation sont réservés au plan Pro.",
    yearlyDescription:
      "Version annuelle du plan Starter : clients, devis et factures PDF. Les achats, paiements et services d'e-facturation sont réservés au plan Pro.",
    cta: "Choisir Starter",
    featured: false,
    features: [
      { text: "Clients, devis, factures et PDF", included: true },
      { text: "1 société / 1 utilisateur", included: true },
      { text: "Branding de base", included: true },
      { text: "Dashboard et paramètres", included: true },
      { text: "Exports CSV / journal", included: true },
      { text: "Achats et paiements réservés au plan Pro", included: false },
      { text: "E-facturation réservée au plan Pro", included: false },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    yearlyName: "Pro annuel",
    tagline: "Préparation e-facturation",
    description:
      "Facturation, achats, suivi des paiements et préparation e-facturation. Les transmissions exigent un contrat, un mandat et un connecteur opérationnel. Les 50 jetons sont réservés à la souscription, puis crédités une fois après activation et disponibilité du stock.",
    yearlyDescription:
      "Version annuelle du plan Pro : facturation, achats, paiements et préparation e-facturation selon contrat, mandat et configuration. Les 50 jetons sont réservés à la souscription, puis crédités une fois après activation et disponibilité du stock.",
    cta: "Choisir Pro",
    featured: true,
    badge: "Recommandé",
    features: [
      { text: "Tout Starter inclus", included: true },
      { text: "1 société / jusqu'à 3 utilisateurs", included: true },
      { text: "Achats fournisseurs et suivi des paiements", included: true },
      { text: "Préparation Chorus Pro B2G ; activation uniquement si configuré", included: true },
      { text: "Préparation connecteur PA ; aucune transmission sans contrat, mandat et activation", included: true },
      { text: "Factur-X après contrôles requis", included: true },
      { text: "50 jetons réservés, puis crédités après activation et disponibilité du stock", included: true },
      { text: "Packs disponibles uniquement après activation opérationnelle", included: true },
      { text: "Rapport de contrôles par facture", included: true },
    ],
  },
  {
    id: "enterprise",
    name: "Volume",
    tagline: "Besoin spécifique",
    description:
      "Pour gros volumes, intégration métier ou accompagnement dédié. Le périmètre est cadré avant activation.",
    cta: "Nous contacter",
    featured: false,
    features: [
      { text: "Tout Pro inclus", included: true },
      { text: "Cadrage volume et intégrations", included: true },
      { text: "Accompagnement au démarrage", included: true },
      { text: "Contrat et support adaptés", included: true },
      { text: "Options avancées après validation", included: true },
    ],
  },
];

const comparisonRows: ComparisonRow[] = [
  { label: "Factures PDF", starter: "Oui", pro: "Oui", enterprise: "Oui" },
  { label: "Clients / devis / factures", starter: "Oui", pro: "Oui", enterprise: "Oui" },
  { label: "Utilisateurs / sociétés", starter: "1 / 1", pro: "Jusqu'à 3 / 1", enterprise: "Selon contrat" },
  { label: "Branding & dashboard", starter: "Oui", pro: "Oui", enterprise: "Oui" },
  { label: "Achats fournisseurs", starter: "-", pro: "Oui", enterprise: "Oui" },
  { label: "Suivi des paiements", starter: "-", pro: "Oui", enterprise: "Oui" },
  {
    label: "Factur-X si facture conforme",
    starter: "-",
    pro: "Selon configuration",
    enterprise: "Selon configuration",
  },
  { label: "Préparation e-facturation", starter: "-", pro: "Oui", enterprise: "Selon contrat" },
  {
    label: "Connecteurs e-facturation",
    starter: "-",
    pro: "Préparation incluse ; activation sous contrat, mandat et configuration",
    enterprise: "Selon contrat",
  },
  {
    label: "Jetons d'activation",
    starter: "-",
    pro: "50 réservés, puis crédités après activation et disponibilité du stock",
    enterprise: "Selon contrat",
  },
  {
    label: "Recharges de jetons",
    starter: "-",
    pro: "Packs 100 / 500 / 1000 / 5000 si connecteur opérationnel",
    enterprise: "Selon contrat",
  },
  { label: "E-reporting", starter: "-", pro: "Export Pro selon périmètre", enterprise: "Selon contrat" },
  { label: "Accompagnement", starter: "Standard", pro: "Standard", enterprise: "Cadrage dédié" },
];

const reformCalendar = [
  { date: RECEPTION_DATE_SHORT, label: "Réception obligatoire pour toutes les entreprises" },
  { date: EMISSION_GE_ETI_DATE_SHORT, label: "Émission : grandes entreprises et ETI" },
  { date: EMISSION_PME_DATE_SHORT, label: "Émission : PME et micro-entreprises" },
  { date: "2026-2027", label: "E-reporting : calendrier progressif selon périmètre (PA / export)" },
];

const officialLinks = [
  { label: "Calendrier officiel", href: OFFICIAL_CALENDAR_URL },
  { label: "Spécifications B2B (DGFiP)", href: OFFICIAL_B2B_SPECS_URL },
  { label: "Liste plateformes agréées", href: OFFICIAL_PDP_LIST_URL },
];

const defaultPrice = (planId: BillingPlanId, period: BillingPlanPeriod) => {
  if (planId === "starter") return period === "yearly" ? "290" : "29";
  return period === "yearly" ? "590" : "59";
};

const amountFromPlan = (plan: BillingPlan | null, fallback: string) => {
  if (!plan) return fallback;
  return formatAmountDisplay(plan.amount_display).replace(/,00$/, "");
};

const planCheckoutState = (plansData: BillingPlan[] | null, planId: BillingPlanId, period: BillingPlanPeriod) => {
  if (plansData === null) return { loading: true, enabled: false, contact: false, message: null as string | null };
  const plan = findPlan(plansData, planId, period);
  if (!plan) {
    return {
      loading: false,
      enabled: false,
      contact: true,
      message: "Tarif indisponible pour cette période.",
    };
  }
  const enabled = plan.checkout_enabled === true || plan.availability === "checkout";
  return {
    loading: false,
    enabled,
    contact: !enabled && plan.availability !== "unavailable",
    message: plan.message || null,
  };
};

export default function PricingPage() {
  const [billingPeriod, setBillingPeriod] = useState<BillingPlanPeriod>("monthly");
  const [plansData, setPlansData] = useState<BillingPlan[] | null>(null);
  const [pricingSource, setPricingSource] = useState<"loading" | PricingSource>("loading");
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [redirectingPlan, setRedirectingPlan] = useState<BillingPlanId | null>(null);
  const [showComparison, setShowComparison] = useState(false);
  const [sessionCheckEnabled, setSessionCheckEnabled] = useState(false);
  const { user, loading: sessionLoading } = useSession({ autoRefresh: sessionCheckEnabled });
  const runtimeClaims = useComplianceMarketingStatus();
  const resolvedClaim = resolveMarketingClaimLevel(undefined, runtimeClaims, featureFlags);
  const showPartnered = shouldShowPartneredMessaging(runtimeClaims, featureFlags);
  const partnerName = partnerNameLabel(runtimeClaims, featureFlags);
  const isPartnered = resolvedClaim === "partnered" && showPartnered;
  const isCompatible = resolvedClaim === "compatible" && !isPartnered;

  const isYearly = billingPeriod === "yearly";
  const selectedPlan = (planId: BillingPlanId) => (plansData ? findPlan(plansData, planId, billingPeriod) : null);
  const starterState = planCheckoutState(plansData, "starter", billingPeriod);
  const proState = planCheckoutState(plansData, "pro", billingPeriod);
  const billingReady = starterState.enabled || proState.enabled;
  const billingUnavailable = billingStatus ? !billingReady && !starterState.loading && !proState.loading : false;
  const pricingUnavailable = pricingSource === "error" && !billingUnavailable;
  const isFallback = pricingSource === "fallback";

  const pricingNotice = isPartnered
    ? `Transmission e-facturation via la ${EXPLANATION} ${partnerName} après mandat/contrat.`
    : isCompatible
      ? `Transmission e-facturation via ${EXPLANATION} de votre choix après mandat/contrat.`
      : `Mode export et connecteurs Pro : transmission via ${EXPLANATION} après mandat, contrat et configuration.`;

  const complianceItems = [
    {
      label: `Réforme ${CALENDAR_RANGE || "2026-2027"}`,
      value: "Factur-X / EN16931 (CII) : génération + contrôles applicatifs selon configuration",
      icon: "ok",
    },
    { label: "E-facturation", value: "Préparation Pro selon mandat, contrat PA et configuration", icon: "ok" },
    {
      label: "Jetons de transmission",
      value:
        "50 réservés à la souscription Pro, puis crédités après activation et disponibilité du stock ; packs disponibles ensuite selon le connecteur",
      icon: "ok",
    },
    { label: "E-reporting", value: "Export Pro selon périmètre ; transmission PA selon activation", icon: "progress" },
    {
      label: "Canal public (B2G)",
      value: "Préparation avec Pro ; activation uniquement lorsque Chorus est configuré",
      icon: "ok",
    },
    { label: "4 nouvelles données à prévoir", value: "SIREN, livraison, nature, TVA sur débits", icon: "ok" },
    { label: "Archivage", value: "Conservation à paramétrer selon vos obligations", icon: "ok" },
  ];

  useEffect(() => {
    setSessionCheckEnabled(hasHadSession());
  }, []);

  useEffect(() => {
    let active = true;
    fetchPublicPlansPricing()
      .then(({ plans: fetchedPlans, source }) => {
        if (!active) return;
        setPlansData(fetchedPlans);
        setPricingSource(source);
      })
      .catch(() => {
        if (!active) return;
        setPlansData([]);
        setPricingSource("error");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetchBillingStatus()
      .then((status) => {
        if (!active) return;
        setBillingStatus(status);
      })
      .catch(() => {
        if (!active) return;
        setBillingStatus(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const persistPreferredSelection = (plan: BillingPlanId | null, period: BillingPlanPeriod) => {
    if (typeof window === "undefined") return;
    if (plan) localStorage.setItem("preferred_plan", plan);
    localStorage.setItem("preferred_billing_period", period);
  };

  const changeBillingPeriod = (period: BillingPlanPeriod) => {
    setBillingPeriod(period);
    persistPreferredSelection(null, period);
  };

  const redirectToContact = () => {
    window.location.href = "/contact";
  };

  const choosePlan = (planId: BillingPlanId) => {
    if (sessionLoading) return;
    const state = planId === "starter" ? starterState : proState;
    if (state.loading || (!state.enabled && !state.contact)) return;
    if (!state.enabled) {
      redirectToContact();
      return;
    }
    setRedirectingPlan(planId);
    persistPreferredSelection(planId, billingPeriod);
    const params = new URLSearchParams({ plan: planId, period: billingPeriod, checkout: "1" });
    window.location.href = user ? `/app/billing?${params.toString()}` : `/app/register?${params.toString()}`;
  };

  const ctaLabel = (plan: MarketingPlan) => {
    if (plan.id === "enterprise") return plan.cta;
    const state = plan.id === "starter" ? starterState : proState;
    if (redirectingPlan === plan.id) return "Redirection...";
    if (sessionLoading) return "Vérification du compte...";
    if (state.loading) return "Chargement...";
    if (state.enabled) return plan.cta;
    return state.contact ? "Nous contacter" : "Indisponible";
  };

  const ctaDisabled = (plan: MarketingPlan) => {
    if (plan.id === "enterprise") return false;
    const state = plan.id === "starter" ? starterState : proState;
    return sessionLoading || redirectingPlan === plan.id || state.loading || (!state.enabled && !state.contact);
  };

  const renderPrice = (plan: MarketingPlan) => {
    if (plan.id === "enterprise") return "Sur devis";
    return `${amountFromPlan(selectedPlan(plan.id), defaultPrice(plan.id, billingPeriod))}€`;
  };

  const renderPlanAction = (plan: MarketingPlan) => {
    if (plan.id === "enterprise") {
      return (
        <motion.a
          href="/contact"
          className="pricing-arc-plan__cta"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
        >
          {plan.cta}
        </motion.a>
      );
    }
    const planId = plan.id;
    return (
      <motion.button
        type="button"
        className="pricing-arc-plan__cta"
        disabled={ctaDisabled(plan)}
        onClick={() => choosePlan(planId)}
        whileHover={{ scale: ctaDisabled(plan) ? 1 : 1.02 }}
        whileTap={{ scale: ctaDisabled(plan) ? 1 : 0.97 }}
      >
        {ctaLabel(plan)}
      </motion.button>
    );
  };

  return (
    <main id="main-content" className="pricing-arc">
      <div className="pricing-arc__container">
        <section className="pricing-arc__hero" aria-labelledby="pricing-title">
          <span className="pricing-arc__eyebrow">Tarifs</span>
          <h1 id="pricing-title">Plans adaptés à votre volume</h1>
          <p>
            Évoluez selon vos besoins. Démarrez en mode facturation classique, puis activez le mode connecté selon votre
            contrat et votre plateforme agréée.
          </p>
          <div className="pricing-arc__chips" role="group" aria-label="Informations tarifaires">
            <span>Essai Pro {TRIAL_DAYS} jours</span>
            <span>Mensuel ou annuel, selon votre choix</span>
            <span>Prix HT</span>
            {LAST_UPDATED ? <span>MAJ : {LAST_UPDATED}</span> : null}
          </div>

          <div className="pricing-arc__toggle" role="group" aria-label={PRICING_COPY.plans.billingToggle.ariaLabel}>
            <button
              type="button"
              className={!isYearly ? "is-active" : ""}
              onClick={() => changeBillingPeriod("monthly")}
              aria-pressed={!isYearly}
            >
              Mensuel
            </button>
            <button
              type="button"
              className={isYearly ? "is-active" : ""}
              onClick={() => changeBillingPeriod("yearly")}
              aria-pressed={isYearly}
            >
              Annuel
              <AnimatePresence>
                {isYearly ? (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.7 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.7 }}
                    className="pricing-arc__save-badge"
                  >
                    -2 mois
                  </motion.span>
                ) : null}
              </AnimatePresence>
              {!isYearly ? <span className="pricing-arc__save-soft">économisez</span> : null}
            </button>
          </div>
        </section>

        {(billingUnavailable || pricingUnavailable || (isFallback && IS_NON_PROD)) && (
          <section className="pricing-arc-alert" aria-label="Information paiement">
            <AlertCircle size={16} aria-hidden="true" />
            <p>
              {billingUnavailable
                ? "La souscription en ligne est temporairement indisponible. Contactez-nous pour activer un plan."
                : pricingUnavailable
                  ? "Les tarifs sont temporairement indisponibles. Contactez-nous pour choisir un plan."
                  : "Mode local : tarifs de test affichés."}
            </p>
          </section>
        )}

        <section className="pricing-arc__grid" aria-label="Plans PixFacture">
          {plans.map((plan) => {
            const displayName = isYearly ? plan.yearlyName || plan.name : plan.name;
            const displayDescription = isYearly ? plan.yearlyDescription || plan.description : plan.description;
            const checkoutState = plan.id === "starter" ? starterState : plan.id === "pro" ? proState : null;
            return (
              <motion.article
                key={plan.name}
                className={`pricing-arc-plan ${plan.featured ? "is-featured" : ""}`}
                whileHover={{ y: plan.featured ? -8 : -5 }}
                transition={{ type: "spring", stiffness: 280, damping: 20 }}
              >
                {plan.featured && plan.badge ? (
                  <div className="pricing-arc-plan__badge">
                    <Sparkles size={12} aria-hidden="true" /> {plan.badge}
                  </div>
                ) : null}

                <div className="pricing-arc-plan__head">
                  <p className="pricing-arc-plan__tagline">{plan.tagline}</p>
                  <h2>{displayName}</h2>
                  <div className="pricing-arc-plan__price">
                    <AnimatePresence mode="wait">
                      <motion.span
                        key={`${plan.id}-${billingPeriod}`}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.2 }}
                      >
                        {renderPrice(plan)}
                      </motion.span>
                    </AnimatePresence>
                    {plan.id !== "enterprise" ? <small>/{isYearly ? "an" : "mois"}</small> : null}
                  </div>
                  <p>{displayDescription}</p>
                </div>

                <ul className="pricing-arc-plan__features">
                  {plan.features.map((feature) => (
                    <li className={!feature.included ? "is-muted" : ""} key={feature.text}>
                      <span className="pricing-arc-plan__feature-icon">
                        {feature.included ? (
                          <Check size={11} aria-hidden="true" />
                        ) : (
                          <Minus size={10} aria-hidden="true" />
                        )}
                      </span>
                      {feature.text}
                    </li>
                  ))}
                </ul>

                {renderPlanAction(plan)}
                {checkoutState && !checkoutState.loading && !checkoutState.enabled && checkoutState.message ? (
                  <p className="pricing-arc-plan__availability" role="status">
                    {checkoutState.message}
                  </p>
                ) : null}
              </motion.article>
            );
          })}
        </section>

        <section className="pricing-arc-alert" aria-label="Limites du plan Starter">
          <AlertCircle size={16} aria-hidden="true" />
          <p>
            <strong>À savoir avant de choisir Starter :</strong> ce plan permet d'émettre des factures classiques en
            PDF, mais n'inclut ni les achats, ni le suivi des paiements, ni la réception ou l'émission d'e-factures via
            une plateforme agréée. À compter du {RECEPTION_DATE_SHORT}, Starter ne couvre donc pas, à lui seul,
            l'obligation de réception électronique. Le plan Pro prépare ces usages, mais une transmission reste soumise
            au contrat, au mandat et à l'activation du connecteur.
          </p>
        </section>

        <section className="pricing-arc-compliance" aria-labelledby="pricing-compliance">
          <div className="pricing-arc-section-title">
            <span>
              <Zap size={14} aria-hidden="true" />
            </span>
            <h2 id="pricing-compliance">Préparation réforme {CALENDAR_RANGE || "2026-2027"}</h2>
          </div>
          <p className="pricing-arc-compliance__claim">
            <ComplianceClaimInline variant="subline" />
          </p>
          <div className="pricing-arc-compliance__grid">
            {complianceItems.map((item) => (
              <div className="pricing-arc-compliance__item" key={item.label}>
                <strong aria-hidden="true" className={item.icon === "ok" ? "is-ok" : "is-progress"}>
                  {item.icon === "ok" ? "✓" : "⟳"}
                </strong>
                <p>
                  <b>{item.label} - </b>
                  {item.value}
                </p>
              </div>
            ))}
          </div>
          <div className="pricing-arc-compliance__foot">
            <p>PA = plateforme agréée (ex-PDP). {pricingNotice} L'abonnement seul ne crée pas le mandat.</p>
            <OfficialPdpStatusNote />
          </div>
        </section>

        <section className="pricing-arc-reform" aria-labelledby="pricing-reform">
          <span className="pricing-arc-reform__eyebrow">Réforme</span>
          <h2 id="pricing-reform">{CALENDAR_RANGE || "2026-2027"} : calendrier & mentions</h2>
          <div className="pricing-arc-reform__grid">
            <div>
              <p className="pricing-arc-reform__title">Calendrier officiel</p>
              <div className="pricing-arc-timeline">
                {reformCalendar.map((item) => (
                  <div className="pricing-arc-timeline__item" key={`${item.date}-${item.label}`}>
                    <span>{item.date}</span>
                    <p>{item.label}</p>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="pricing-arc-reform__title">4 nouvelles données à prévoir</p>
              <ul className="pricing-arc-checklist">
                {[
                  "SIREN du client",
                  "Adresse de livraison (si différente)",
                  "Nature de l'opération : biens / services / mixte",
                  "TVA sur les débits (mention si applicable)",
                ].map((item) => (
                  <li key={item}>
                    <span>
                      <Check size={11} aria-hidden="true" />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="pricing-arc-official-links">
            {officialLinks.map((link) => (
              <a href={link.href} target="_blank" rel="noopener noreferrer" key={link.href}>
                {link.label} <ExternalLink size={10} aria-hidden="true" />
              </a>
            ))}
          </div>
        </section>

        <details className="pricing-arc-calendar">
          <summary>Sources officielles du calendrier</summary>
          <div>
            <Calendar2026Block />
          </div>
        </details>

        <section className="pricing-arc-compare" id={PRICING_COPY.comparison.id} aria-labelledby="pricing-comparison">
          <h2 id="pricing-comparison" className="sr-only">
            Comparatif détaillé des offres
          </h2>
          <button
            type="button"
            onClick={() => setShowComparison((value) => !value)}
            aria-expanded={showComparison}
            aria-controls={showComparison ? "pricing-comparison-content" : undefined}
          >
            {showComparison ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
            {showComparison ? "Masquer" : "Afficher"} le tableau comparatif complet
          </button>
          <AnimatePresence initial={false}>
            {showComparison ? (
              <motion.div
                id="pricing-comparison-content"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                className="pricing-arc-compare__motion"
              >
                <div className="pricing-arc-table-wrap">
                  <table className="pricing-arc-table">
                    <thead>
                      <tr>
                        <th>Fonctionnalité</th>
                        <th>Starter</th>
                        <th>Pro</th>
                        <th>Volume</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparisonRows.map((row) => (
                        <tr key={row.label}>
                          <td>{row.label}</td>
                          <td>{row.starter}</td>
                          <td>{row.pro}</td>
                          <td>{row.enterprise}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pricing-arc-mobile-compare">
                  {comparisonRows.map((row) => (
                    <article key={row.label}>
                      <h3>{row.label}</h3>
                      <dl>
                        <div>
                          <dt>Starter</dt>
                          <dd>{row.starter}</dd>
                        </div>
                        <div>
                          <dt>Pro</dt>
                          <dd>{row.pro}</dd>
                        </div>
                        <div>
                          <dt>Volume</dt>
                          <dd>{row.enterprise}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>

        <section className="pricing-arc-faq" aria-labelledby="pricing-faq">
          <div className="pricing-arc-faq__head">
            <h2 id="pricing-faq">{PRICING_COPY.faq.title}</h2>
            <p>{PRICING_COPY.faq.subtitle}</p>
          </div>
          <div className="pricing-arc-faq__list">
            {PRICING_COPY.faq.items.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <footer className="pricing-arc-footer">
          <div>
            <AlertCircle size={13} aria-hidden="true" />
            <span>
              Déjà client ?{" "}
              <Link
                href={`/app/login?next=/app/billing&period=${billingPeriod}`}
                onClick={() => persistPreferredSelection(null, billingPeriod)}
              >
                Se connecter
              </Link>{" "}
              · <Link href="/features">Voir toutes les fonctionnalités</Link>
            </span>
          </div>
          <Link href="/contact">
            Cas particulier ? Parler à un expert <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </footer>
      </div>
    </main>
  );
}

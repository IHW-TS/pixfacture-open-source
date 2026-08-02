"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { api, formatApiError } from "@/lib/api";
import { fetchBillingStatus, fetchPublicPlansPricing } from "@/lib/billingApi";
import { refreshSession as refreshSessionState, useSession } from "@/lib/useSession";
import { useHydrated } from "@/lib/useHydrated";
import { TRIAL_DAYS } from "@/lib/billingConstants";
import BillingLegalAcceptanceModal from "@/components/BillingLegalAcceptanceModal";
import { AppPageHeader } from "../../components/app/AppPageHeader";
import {
  AlertCircle,
  ArrowUpRight,
  Building2,
  Check,
  CreditCard,
  FileText,
  History,
  RefreshCw,
  Shield,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";

type LegalDoc = {
  slug: string;
  version: string;
  url?: string;
};

const legalDocKey = (doc: LegalDoc) => `${doc.slug}:${doc.version}`;
const TOKEN_HISTORY_PAGE_SIZE = 10;

const checkoutRequestId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const planMeta: Record<string, any> = {
  starter: {
    id: "starter",
    name: "Starter",
    yearlyName: "Starter annuel",
    desc: "Facturation classique pour TPE/PME : clients, devis, factures, PDF et branding de base.",
    yearlyDesc: "Facturation classique en paiement annuel : clients, devis, factures, PDF et branding de base.",
    color: "from-[#64748b] to-[#475569]",
    popular: false,
    features: [
      "Clients, devis, factures et PDF",
      "Branding de base",
      "Achats et paiements réservés au plan Pro",
      "Sans e-facturation ni connecteurs",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    yearlyName: "Pro annuel",
    desc: "Tout Starter, plus achats, paiements et préparation e-facturation. Les transmissions exigent contrat, mandat et connecteur actif.",
    yearlyDesc:
      "Pro annuel avec achats, paiements et préparation e-facturation. Les transmissions exigent contrat, mandat et connecteur actif.",
    color: "from-[#1e3a8a] to-[#334155]",
    popular: true,
    features: [
      "Tout Starter",
      "Achats fournisseurs et suivi des paiements",
      "Préparation connecteur PA ; activation selon contrat, mandat et configuration",
      "50 jetons réservés, puis crédités après activation et disponibilité du stock",
      "Packs disponibles uniquement avec un connecteur opérationnel",
    ],
  },
  enterprise: {
    id: "enterprise",
    name: "Volume",
    desc: "Pour les grandes structures et groupes.",
    color: "from-[#4c1d95] to-[#475569]",
    popular: false,
    features: [],
  },
};

const fallbackPrice: Record<string, { monthly: string; yearly: string }> = {
  starter: { monthly: "29", yearly: "290" },
  pro: { monthly: "59", yearly: "590" },
  enterprise: { monthly: "Sur devis", yearly: "Sur devis" },
};

const tokenPackFallback: Record<number, { name: string; amount: string }> = {
  100: { name: "Pack 100 jetons", amount: "29" },
  500: { name: "Pack 500 jetons", amount: "129" },
  1000: { name: "Pack 1000 jetons", amount: "249" },
  5000: { name: "Pack 5000 jetons", amount: "1199" },
};

const planOrder = ["starter", "pro", "enterprise"] as const;
const planComparisonRows = [
  { label: "Factures, devis et PDF", starter: true, pro: true, enterprise: true },
  { label: "Achats fournisseurs", starter: false, pro: true, enterprise: true },
  { label: "Suivi des paiements", starter: false, pro: true, enterprise: true },
  { label: "Factur-X EN16931", starter: false, pro: "Selon conformité et configuration", enterprise: "Selon contrat" },
  { label: "Connecteurs réglementaires", starter: false, pro: "Selon activation", enterprise: "Selon contrat" },
  { label: "Export e-reporting", starter: false, pro: true, enterprise: "Sur mesure" },
  { label: "Transmission PA e-reporting", starter: false, pro: "Selon activation", enterprise: "Selon contrat" },
  { label: "Utilisateurs", starter: "1", pro: "Jusqu'à 3", enterprise: "Selon contrat" },
  {
    label: "Jetons inclus",
    starter: "—",
    pro: "50 réservés, puis crédités après activation et disponibilité du stock",
    enterprise: "Sur mesure",
  },
  { label: "SSO/SCIM et audit avancé", starter: false, pro: false, enterprise: "Sur demande" },
  { label: "Accompagnement dédié", starter: false, pro: false, enterprise: true },
];

function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

const normalizeStatus = (value?: string | null) => (value || "").trim().toLowerCase();

const ledgerTypeLabel = (value: string) => {
  const normalized = (value || "").trim().toLowerCase();
  return (
    {
      welcome_bonus: "Bonus de bienvenue",
      purchase: "Achat de pack",
      usage: "Jeton consommé",
      adjustment: "Ajustement",
      refund: "Remboursement",
    }[normalized] ||
    normalized.replace(/_/g, " ") ||
    "Mouvement"
  );
};

const ledgerBadgeLabel = (entry: any) => {
  const normalized = String(entry?.type || "")
    .trim()
    .toLowerCase();
  const detailKind = String(entry?.detail?.kind || "")
    .trim()
    .toLowerCase();
  if (normalized === "usage") {
    if (detailKind === "invoice") return "Transmission PA";
    if (detailKind === "ereporting_event" || detailKind === "ereporting_report") return "E-reporting";
    return "Jeton consommé";
  }
  return ledgerTypeLabel(normalized);
};

const formatLedgerDate = (value?: string | null) => {
  if (!value) return "Date inconnue";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date inconnue";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const TEMPORARY_BILLING_REASONS = new Set([
  "stripe_auth_failed",
  "stripe_permission_denied",
  "stripe_rate_limited",
  "stripe_unreachable",
  "stripe_invalid_request",
  "stripe_unavailable",
  "price_lookup_failed",
]);

const unavailableLabel = (reason?: string | null) => {
  const normalizedReason = String(reason || "")
    .trim()
    .toLowerCase();
  if (normalizedReason === "transmissions_not_operational") return "Connecteur non activé";
  if (normalizedReason === "pro_welcome_stock_unavailable") return "Pro temporairement indisponible";
  return TEMPORARY_BILLING_REASONS.has(normalizedReason)
    ? "Temporairement indisponible"
    : "Indisponible pour ce compte";
};

export function BillingPage({
  initialBillingStatus = null,
  initialPlansPricing = null,
}: {
  initialBillingStatus?: any;
  initialPlansPricing?: any;
}) {
  const hydrated = useHydrated();
  const { plan, subscriptionStatus, capabilities, loading: sessionLoading, sessionError } = useSession();
  const [period, setPeriod] = useState<"monthly" | "yearly">("yearly");
  const [activeTokenPackKey, setActiveTokenPackKey] = useState<string | null>(null);
  const initialPlans = Array.isArray(initialPlansPricing?.plans)
    ? initialPlansPricing.plans
    : Array.isArray(initialPlansPricing)
      ? initialPlansPricing
      : [];
  const hasInitialBillingData = Boolean(initialBillingStatus) || initialPlans.length > 0;
  const [loading, setLoading] = useState(!hasInitialBillingData);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [tokenCheckoutBusy, setTokenCheckoutBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [billingStatus, setBillingStatus] = useState<any>(initialBillingStatus);
  const [plans, setPlans] = useState<any[]>(initialPlans);
  const [tokenState, setTokenState] = useState<any>(null);
  const [tokenPacks, setTokenPacks] = useState<any[]>([]);
  const [tokenDataError, setTokenDataError] = useState<string | null>(null);
  const [pendingCheckoutPlan, setPendingCheckoutPlan] = useState<string | null>(null);
  const [billingLegalDocs, setBillingLegalDocs] = useState<LegalDoc[]>([]);
  const [billingLegalOpen, setBillingLegalOpen] = useState(false);
  const [billingLegalSubmitting, setBillingLegalSubmitting] = useState(false);
  const [billingLegalError, setBillingLegalError] = useState<string | null>(null);
  const [tokenHistoryOpen, setTokenHistoryOpen] = useState(false);
  const [tokenHistoryPage, setTokenHistoryPage] = useState(1);
  const [autoCheckoutPlan, setAutoCheckoutPlan] = useState<string | null>(null);
  const [autoCheckoutHandled, setAutoCheckoutHandled] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError(null);
      setTokenDataError(null);
      try {
        const shouldLoadTokenData = Boolean(capabilities?.token_topup_enabled);
        const [statusData, pricingData, tokenStateResult, tokenPacksResult] = await Promise.all([
          fetchBillingStatus(),
          fetchPublicPlansPricing(),
          shouldLoadTokenData
            ? api("/api/tokens/balance?history_limit=100", { method: "GET" })
                .then((value) => ({ status: "fulfilled" as const, value }))
                .catch((reason) => ({ status: "rejected" as const, reason }))
            : Promise.resolve({ status: "skipped" as const }),
          shouldLoadTokenData
            ? api("/api/tokens/packs", { method: "GET" })
                .then((value) => ({ status: "fulfilled" as const, value }))
                .catch((reason) => ({ status: "rejected" as const, reason }))
            : Promise.resolve({ status: "skipped" as const }),
        ]);
        setBillingStatus(statusData);
        setPlans(Array.isArray(pricingData?.plans) ? pricingData.plans : []);
        if (tokenStateResult.status === "fulfilled") {
          setTokenState(tokenStateResult.value);
        }
        if (tokenPacksResult.status === "fulfilled") {
          setTokenPacks(Array.isArray(tokenPacksResult.value) ? tokenPacksResult.value : []);
        }
        if (!shouldLoadTokenData) {
          setTokenState(null);
          setTokenPacks([]);
        }
        if (tokenStateResult.status === "rejected" || tokenPacksResult.status === "rejected") {
          setTokenDataError("Les jetons sont temporairement indisponibles. Actualisez la page dans quelques instants.");
        }
      } catch (err) {
        setError(formatApiError(err, "Impossible de charger la facturation."));
        setPlans([]);
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [capabilities?.token_topup_enabled],
  );

  useEffect(() => {
    void Promise.allSettled([refreshSessionState(true), load(hasInitialBillingData)]);
  }, [hasInitialBillingData, load]);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const preferredPeriod = params.get("period") || window.localStorage.getItem("preferred_billing_period");
    if (preferredPeriod === "monthly" || preferredPeriod === "yearly") {
      setPeriod(preferredPeriod);
    }
    const preferredPlan = params.get("plan") || window.localStorage.getItem("preferred_plan");
    if (preferredPlan === "starter" || preferredPlan === "pro") {
      setAutoCheckoutPlan(preferredPlan);
    }
    if (params.get("checkout") === "1") {
      window.localStorage.removeItem("preferred_checkout");
    }
  }, [hydrated]);

  const currentPlan = sessionLoading ? null : normalizeStatus(plan) || null;
  const billingStatusLoaded = billingStatus !== null;
  const planSyncPending = hydrated && !sessionLoading && !currentPlan && (billingStatusLoaded || Boolean(sessionError));

  const resolvedPlans = useMemo(() => {
    const mapByKey = new Map<string, any>();
    plans.forEach((row) => {
      const key = `${(row.plan || "").toLowerCase()}::${(row.period || "").toLowerCase()}`;
      mapByKey.set(key, row);
    });

    return ["starter", "pro", "enterprise"].map((id) => {
      if (id === "enterprise") {
        return {
          ...planMeta.enterprise,
          priceMonthly: fallbackPrice.enterprise.monthly,
          priceYearly: fallbackPrice.enterprise.yearly,
          source: "contact",
        };
      }
      const monthly = mapByKey.get(`${id}::monthly`);
      const yearly = mapByKey.get(`${id}::yearly`);
      return {
        ...planMeta[id],
        monthlyPlan: monthly || null,
        yearlyPlan: yearly || null,
        priceMonthly: monthly?.amount_display ?? fallbackPrice[id].monthly,
        priceYearly: yearly?.amount_display ?? fallbackPrice[id].yearly,
        source: monthly?.pricing_source || yearly?.pricing_source || "fallback",
      };
    });
  }, [plans]);

  const tokenPackLabel = (pack: any) => {
    const tokens = Number(pack?.tokens || 0);
    const fallback = tokenPackFallback[tokens];
    const name =
      typeof pack?.name === "string" && pack.name
        ? pack.name.replace(/jetons? Seqino/gi, "jetons")
        : fallback?.name || `Pack ${tokens} jetons`;
    const amount =
      typeof pack?.amount_display === "string" && pack.amount_display ? pack.amount_display : fallback?.amount || "";
    return amount ? `${name} · ${amount} €` : name;
  };

  const tokenPackDisabledLabel = (pack: any) => `${tokenPackLabel(pack)} · ${unavailableLabel(pack?.reason)}`;
  const tokenPackDisplay = (pack: any) => {
    const tokens = Number(pack?.tokens || 0);
    const fallback = tokenPackFallback[tokens];
    const name =
      typeof pack?.name === "string" && pack.name
        ? pack.name.replace(/jetons? Seqino/gi, "jetons")
        : fallback?.name || `Pack ${tokens} jetons`;
    const amount =
      typeof pack?.amount_display === "string" && pack.amount_display ? pack.amount_display : fallback?.amount || "";
    return {
      amount,
      name,
      tokens: Number.isFinite(tokens) ? tokens : 0,
      title: tokens ? `${tokens.toLocaleString("fr-FR")} jetons` : name,
    };
  };

  const amountNumber = (value: string) => {
    const normalized = String(value || "")
      .replace(/\s/g, "")
      .replace(",", ".")
      .replace(/[^\d.]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const checkoutAvailabilityForPlan = (targetPlan: string) => {
    const planItem = resolvedPlans.find((row) => row.id === targetPlan);
    if (!planItem || planItem.id === "enterprise") {
      return { availability: "contact", reason: "plan_contact" };
    }
    const selectedPlanConfig = period === "yearly" ? planItem.yearlyPlan : planItem.monthlyPlan;
    if (!selectedPlanConfig) {
      return { availability: "contact", reason: "plan_price_missing" };
    }
    const selectedCheckoutEnabled =
      !loading && typeof selectedPlanConfig?.checkout_enabled === "boolean"
        ? selectedPlanConfig.checkout_enabled
        : Boolean(subscriptionCheckoutEnabled);
    const availability = loading
      ? "unavailable"
      : typeof selectedPlanConfig?.availability === "string"
        ? selectedPlanConfig.availability
        : selectedCheckoutEnabled
          ? "checkout"
          : "contact";
    return {
      availability,
      reason: typeof selectedPlanConfig?.reason === "string" ? selectedPlanConfig.reason : null,
      message: typeof selectedPlanConfig?.message === "string" ? selectedPlanConfig.message : null,
    };
  };

  const runCheckout = async (targetPlan: string) => {
    if (busyPlan) return;
    setBusyPlan(targetPlan);
    setError(null);
    setNotice(null);
    try {
      const response: any = await api(
        `/api/billing/checkout?plan=${encodeURIComponent(targetPlan)}&billing_period=${encodeURIComponent(period)}&checkout_request_id=${encodeURIComponent(checkoutRequestId())}`,
        {
          method: "POST",
        },
      );
      if (!response?.url) {
        throw new Error("Le paiement sécurisé n'a pas pu être ouvert.");
      }
      window.location.href = response.url;
    } catch (err) {
      if ((err as any)?.code === "subscription_already_active") {
        setError(
          "Votre abonnement est déjà actif. Contactez-nous pour changer de formule sans interrompre votre abonnement.",
        );
        return;
      }
      setError(formatApiError(err, "Impossible d'ouvrir le paiement sécurisé."));
    } finally {
      setBusyPlan(null);
    }
  };

  const startCheckout = async (targetPlan: string) => {
    if (busyPlan) return;
    setError(null);
    setNotice(null);
    setBillingLegalError(null);
    const checkoutAvailability = checkoutAvailabilityForPlan(targetPlan);
    if (checkoutAvailability.availability !== "checkout") {
      setPendingCheckoutPlan(null);
      setError(
        checkoutAvailability.message ||
          "Ce plan nécessite une activation support. Contactez-nous pour finaliser l’activation.",
      );
      return;
    }
    setPendingCheckoutPlan(targetPlan);
    try {
      const response: any = await api("/api/legal/required", {
        method: "GET",
        headers: { "x-legal-context": "billing" },
      });
      const requiredDocs: LegalDoc[] = Array.isArray(response?.required) ? response.required : [];
      const acceptedDocs: LegalDoc[] = Array.isArray(response?.alreadyAccepted) ? response.alreadyAccepted : [];
      const acceptedKeys = new Set(acceptedDocs.map(legalDocKey));
      const docs = requiredDocs.filter((doc) => !acceptedKeys.has(legalDocKey(doc)));
      if (docs.length > 0) {
        setBillingLegalDocs(docs);
        setBillingLegalOpen(true);
        return;
      }
      await runCheckout(targetPlan);
    } catch (err) {
      setPendingCheckoutPlan(null);
      setError(formatApiError(err, "Vérification des documents légaux impossible."));
    }
  };

  useEffect(() => {
    if (!hydrated || autoCheckoutHandled || loading || sessionLoading || !autoCheckoutPlan) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") !== "1") return;
    setAutoCheckoutHandled(true);
    void startCheckout(autoCheckoutPlan);
    // startCheckout depends on the current billing state; autoCheckoutHandled prevents repeated execution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheckoutHandled, autoCheckoutPlan, hydrated, loading, sessionLoading]);

  const acceptBillingLegalDocs = async (docs: LegalDoc[]) => {
    if (!pendingCheckoutPlan || billingLegalSubmitting) return;
    setBillingLegalSubmitting(true);
    setBillingLegalError(null);
    try {
      for (const doc of docs) {
        await api("/api/legal/accept", {
          method: "POST",
          body: JSON.stringify({ slug: doc.slug, version: doc.version }),
        });
      }
      const targetPlan = pendingCheckoutPlan;
      setBillingLegalOpen(false);
      setBillingLegalDocs([]);
      setPendingCheckoutPlan(null);
      await runCheckout(targetPlan);
    } catch (err) {
      setBillingLegalError(formatApiError(err, "Enregistrement de l'acceptation impossible."));
    } finally {
      setBillingLegalSubmitting(false);
    }
  };

  const cancelBillingLegalAcceptance = () => {
    if (billingLegalSubmitting) return;
    setBillingLegalOpen(false);
    setBillingLegalDocs([]);
    setPendingCheckoutPlan(null);
    setBillingLegalError(null);
  };

  const billingEnabled = billingStatusLoaded ? Boolean(billingStatus?.billing_enabled) : null;
  const subscriptionSystemStatus = billingStatus?.subscription_status || null;
  const subscriptionStatusMessage = billingStatus?.subscription_message || null;
  const normalizedSubscriptionStatus = normalizeStatus(subscriptionStatus);
  const normalizedSubscriptionSystemStatus = normalizeStatus(subscriptionSystemStatus);
  const subscriptionStatusUnknown = !normalizedSubscriptionStatus;
  const subscriptionTrialing = normalizedSubscriptionStatus === "trialing";
  const currentSubscriptionActive = ["active", "trialing"].includes(normalizedSubscriptionStatus);
  const subscriptionCheckoutEnabled =
    billingStatusLoaded && typeof billingStatus?.subscription_checkout_enabled === "boolean"
      ? billingStatus.subscription_checkout_enabled
      : null;
  const tokenTopupStatus = billingStatus?.token_topup_status || null;
  const tokenTopupMessage = billingStatus?.token_topup_message || null;
  const fullTokenHistory = Array.isArray(tokenState?.history) ? tokenState.history : [];
  const tokenBalanceKnown = tokenState && Number.isFinite(Number(tokenState.balance));
  const tokenBalance = tokenBalanceKnown ? Number(tokenState.balance) : 0;
  const visibleTokenPacks = tokenPacks.filter((pack: any) => typeof pack?.tokens === "number");
  const hasUnavailableTokenPacks = visibleTokenPacks.some((pack: any) => pack?.checkout_enabled === false);
  const tokensEnabled = Boolean(capabilities?.token_topup_enabled);
  const hasTokenHistory = fullTokenHistory.length > 0;
  const tokenHistoryPageCount = Math.max(1, Math.ceil(fullTokenHistory.length / TOKEN_HISTORY_PAGE_SIZE));
  const safeTokenHistoryPage = Math.min(tokenHistoryPage, tokenHistoryPageCount);
  const paginatedTokenHistory = fullTokenHistory.slice(
    (safeTokenHistoryPage - 1) * TOKEN_HISTORY_PAGE_SIZE,
    safeTokenHistoryPage * TOKEN_HISTORY_PAGE_SIZE,
  );
  const showNoTokensNotice = tokensEnabled && tokenBalanceKnown && tokenBalance <= 0;
  const billingSystemNotice = !billingStatusLoaded
    ? null
    : billingEnabled === false
      ? { tone: "warn", text: subscriptionStatusMessage || "Souscription en ligne bientôt disponible." }
      : normalizedSubscriptionSystemStatus && normalizedSubscriptionSystemStatus !== "enabled"
        ? { tone: "warn", text: subscriptionStatusMessage || "Configuration de facturation en cours." }
        : null;
  const planSyncNotice = !planSyncPending
    ? null
    : "Plan non encore synchronisé. Actualisez cette page ou reconnectez-vous si votre abonnement vient de changer.";
  const tokenSystemNotice =
    !capabilities?.token_topup_enabled || !billingStatusLoaded || !tokenTopupStatus || tokenTopupStatus === "enabled"
      ? null
      : tokenTopupMessage ||
        (hasUnavailableTokenPacks ? "Certains packs ne sont pas encore disponibles à l'achat." : null);
  const currentPlanData = currentPlan ? resolvedPlans.find((row) => row.id === currentPlan) || null : null;
  const currentPlanName = currentPlanData?.name || "à confirmer";
  const currentPlanDisplay = currentPlanName === "Pro" ? "Plan Pro" : `Plan ${currentPlanName}`;
  const currentPlanStatusLabel = currentSubscriptionActive
    ? currentPlanDisplay + " actif"
    : subscriptionStatusUnknown
      ? currentPlanDisplay + " à confirmer"
      : currentPlanDisplay + " inactif";
  const currentPlanBadgeLabel = currentSubscriptionActive
    ? "ACTIF"
    : subscriptionStatusUnknown
      ? "À CONFIRMER"
      : "À RÉACTIVER";
  const currentPlanVisual =
    currentPlan === "pro"
      ? {
          bg: "#f5f3ff",
          border: "#8b5cf6",
          iconBg: "#7c3aed",
          text: "#4c1d95",
          muted: "#6d5f93",
          badgeBg: "#ede9fe",
          badgeText: "#5b21b6",
        }
      : currentPlan === "enterprise"
        ? {
            bg: "#ecfdf5",
            border: "#10b981",
            iconBg: "#0f766e",
            text: "#064e3b",
            muted: "#4b7f70",
            badgeBg: "#d1fae5",
            badgeText: "#047857",
          }
        : {
            bg: "#f0f9ff",
            border: "#38bdf8",
            iconBg: "#0284c7",
            text: "#0f172a",
            muted: "#64748b",
            badgeBg: "#e0f2fe",
            badgeText: "#0369a1",
          };
  const currentPeriodRaw = normalizeStatus(billingStatus?.billing_period || billingStatus?.period);
  const currentPeriodKnown = currentPeriodRaw === "monthly" || currentPeriodRaw === "yearly";
  const currentPeriodLabel =
    currentPeriodRaw === "monthly" ? "mensuelle" : currentPeriodRaw === "yearly" ? "annuelle" : null;
  const customerPortalEnabled = Boolean(billingStatus?.customer_portal_enabled);
  const bonusTokenLimit = Math.max(1, Number(tokenState?.welcome_bonus_tokens ?? 50));
  const bestPackTokens = visibleTokenPacks.some((pack: any) => Number(pack?.tokens) === 1000)
    ? 1000
    : Number(visibleTokenPacks[Math.min(2, Math.max(0, visibleTokenPacks.length - 1))]?.tokens || 0);
  const selectedTokenPack =
    visibleTokenPacks.find((pack: any) => String(pack.pack) === activeTokenPackKey) ||
    visibleTokenPacks.find((pack: any) => Number(pack?.tokens) === bestPackTokens) ||
    visibleTokenPacks[0] ||
    null;
  const selectedTokenDisplay = selectedTokenPack ? tokenPackDisplay(selectedTokenPack) : null;
  const selectedTokenPackKey = selectedTokenPack ? String(selectedTokenPack.pack) : "";
  const selectedTokenPackCheckoutKnown = selectedTokenPack
    ? typeof selectedTokenPack?.checkout_enabled === "boolean"
    : false;
  const selectedTokenPackDisabled = selectedTokenPack
    ? tokenCheckoutBusy === selectedTokenPackKey ||
      (selectedTokenPackCheckoutKnown && selectedTokenPack.checkout_enabled === false) ||
      !tokensEnabled
    : true;
  const tokenBonusUsed = Math.max(0, bonusTokenLimit - Math.max(0, Math.min(tokenBalance, bonusTokenLimit)));
  const tokenProgress = `${Math.max(4, Math.min(100, (tokenBonusUsed / bonusTokenLimit) * 100))}%`;
  const billingPeriod = currentPeriodRaw === "monthly" ? "monthly" : currentPeriodRaw === "yearly" ? "yearly" : null;
  const currentPlanPrice =
    billingPeriod === "monthly"
      ? currentPlanData?.priceMonthly
      : billingPeriod === "yearly"
        ? currentPlanData?.priceYearly
        : null;
  const currentPlanPriceKnown = currentPlanData?.id === "enterprise" || currentPlanPrice !== null;
  const showUpcomingPayment = Boolean(
    currentSubscriptionActive && currentPlanPriceKnown && (currentPeriodKnown || currentPlanData?.id === "enterprise"),
  );
  const currentPlanPriceLabel = currentPlanData?.id === "enterprise" ? "Sur devis" : `${currentPlanPrice}€`;
  const currentPlanCadenceLabel =
    billingPeriod === "monthly"
      ? "/ mois · HT"
      : billingPeriod === "yearly"
        ? "/ an · HT"
        : "Période en cours de synchronisation";
  const renewalRaw =
    billingStatus?.current_period_end ||
    billingStatus?.subscription_current_period_end ||
    billingStatus?.period_end ||
    billingStatus?.trial_end ||
    null;
  const renewalLabel = renewalRaw ? new Intl.DateTimeFormat("fr-FR").format(new Date(renewalRaw)) : null;

  const startTokenCheckout = async (pack: string) => {
    if (tokenCheckoutBusy) return;
    setTokenCheckoutBusy(pack);
    setError(null);
    setNotice(null);
    try {
      const response: any = await api("/api/tokens/checkout", {
        method: "POST",
        body: JSON.stringify({ pack, checkout_request_id: checkoutRequestId() }),
      });
      if (!response?.url) {
        throw new Error("Le paiement sécurisé n'a pas pu être ouvert.");
      }
      window.location.href = response.url;
    } catch (err) {
      setError(formatApiError(err, "Impossible de démarrer la recharge de jetons."));
    } finally {
      setTokenCheckoutBusy(null);
    }
  };

  const openBillingPortal = async () => {
    setError(null);
    setNotice(null);
    try {
      const response: any = await api("/api/billing/portal", { method: "POST" });
      if (!response?.url) {
        throw new Error("Portail de facturation indisponible.");
      }
      window.location.href = response.url;
    } catch (err) {
      setError(formatApiError(err, "Impossible d'ouvrir la facturation."));
    }
  };

  return (
    <>
      <BillingLegalAcceptanceModal
        open={billingLegalOpen}
        docs={billingLegalDocs}
        submitting={billingLegalSubmitting}
        error={billingLegalError}
        onAccept={acceptBillingLegalDocs}
        onCancel={cancelBillingLegalAcceptance}
      />
      <div>
        <AppPageHeader
          title="Abonnement"
          actions={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openBillingPortal}
                disabled={!customerPortalEnabled}
                title={
                  customerPortalEnabled
                    ? "Ouvrir le portail de facturation"
                    : "Portail de facturation indisponible pour ce compte. Contactez le support si vous devez modifier l'abonnement."
                }
                aria-describedby={!customerPortalEnabled ? "billing-portal-disabled-help" : undefined}
                className="flex items-center gap-1.5 text-[13px] font-medium text-gray-600 border border-gray-200 rounded-xl px-4 py-2.5 hover:bg-gray-50 transition-all disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FileText size={13} className="text-gray-400" /> Gérer la facturation
              </button>
              {!customerPortalEnabled ? (
                <Link
                  id="billing-portal-disabled-help"
                  to="/contact"
                  className="text-[12px] font-semibold text-indigo-700 hover:text-indigo-900 hover:underline"
                >
                  Contacter le support
                </Link>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  document.getElementById("billing-plans")?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
                className="flex items-center gap-1.5 text-[13px] font-semibold text-white rounded-xl px-4 py-2.5 hover:opacity-90 transition-all shadow-lg shadow-indigo-200"
                style={{ background: "linear-gradient(135deg,#5B5FEE,#7C3AED)" }}
              >
                Voir les plans <ArrowUpRight size={13} />
              </button>
            </div>
          }
        />
        <div className="p-5 lg:p-7 w-full space-y-6">
          {error ? (
            <div className="flex items-center gap-2 text-[#dc2626] bg-[#fef2f2] border border-[#fecaca] rounded-xl px-4 py-3 text-[12px] font-semibold">
              <AlertCircle className="w-3.5 h-3.5" />
              {error}
            </div>
          ) : null}
          {notice ? (
            <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-[12px] font-semibold">
              <Check className="w-3.5 h-3.5" />
              {notice}
            </div>
          ) : null}
          {billingSystemNotice || planSyncNotice || tokenSystemNotice ? (
            <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[12px] font-semibold">
              <AlertCircle className="w-3.5 h-3.5" />
              {billingSystemNotice?.text || planSyncNotice || tokenSystemNotice}
            </div>
          ) : null}
          <div className="flex items-start gap-2 text-blue-800 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-[12px] font-semibold">
            <Shield className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>
              Lorsqu’une souscription Pro est disponible, les 50 jetons sont réservés puis crédités une seule fois après
              activation du plan et disponibilité du stock. Leur utilisation et les échanges PA exigent aussi le
              contrat, le mandat, la configuration opérationnelle et la confirmation de l’entreprise.
            </span>
          </div>

          <div
            className="relative rounded-2xl border px-6 py-5 shadow-sm"
            style={{ background: currentPlanVisual.bg, borderColor: currentPlanVisual.border }}
          >
            <div className="grid gap-5 xl:grid-cols-[minmax(260px,0.82fr)_minmax(460px,1.18fr)] xl:items-center">
              <div className="flex min-w-0 items-center gap-4">
                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-sm"
                  style={{ background: currentPlanVisual.iconBg }}
                >
                  <Sparkles size={20} className="text-white" />
                </div>
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <p className="text-[15px] font-bold" style={{ color: currentPlanVisual.text }}>
                      {billingStatusLoaded && currentPlan ? currentPlanStatusLabel : "Plan en cours de synchronisation"}
                    </p>
                    <span
                      className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                      style={{
                        color: currentPlanVisual.badgeText,
                        background: currentPlanVisual.badgeBg,
                        border: `1px solid ${currentPlanVisual.border}`,
                      }}
                    >
                      {billingStatusLoaded && currentPlan ? currentPlanBadgeLabel : "À CONFIRMER"}
                    </span>
                  </div>
                  <p className="text-[12px]" style={{ color: currentPlanVisual.muted }}>
                    {billingStatusLoaded && currentPlan && currentSubscriptionActive ? (
                      <>
                        Abonnement actif
                        {renewalLabel ? (
                          <>
                            {" "}
                            · Renouvellement le{" "}
                            <strong style={{ color: currentPlanVisual.text }}>{renewalLabel}</strong>
                          </>
                        ) : null}{" "}
                        {currentPeriodKnown ? <>· Période {currentPeriodLabel}</> : null}
                      </>
                    ) : billingStatusLoaded && currentPlan ? (
                      subscriptionStatusUnknown ? (
                        "Statut d’abonnement à confirmer avant d’annoncer les fonctionnalités payantes."
                      ) : (
                        "Abonnement à réactiver pour retrouver les fonctionnalités payantes."
                      )
                    ) : (
                      "Les informations d’abonnement seront affichées après confirmation du plan."
                    )}
                  </p>
                  {billingStatusLoaded && currentPlan && showUpcomingPayment ? (
                    <p className="mt-1 text-[11px] font-semibold" style={{ color: currentPlanVisual.text }}>
                      Prochain paiement : {currentPlanPriceLabel} · {currentPlanCadenceLabel}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0">
                {tokensEnabled ? (
                  <div className="space-y-2">
                    {tokenDataError ? (
                      <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
                        <AlertCircle size={12} />
                        {tokenDataError}
                      </div>
                    ) : null}
                    {showNoTokensNotice ? (
                      <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
                        <AlertCircle size={12} />
                        Achetez un pack pour relancer une transmission connectée.
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-[13px] font-extrabold" style={{ color: currentPlanVisual.text }}>
                          Jetons de transmission
                        </p>
                        <p className="text-[11px] uppercase tracking-wider" style={{ color: currentPlanVisual.muted }}>
                          Jetons restants
                        </p>
                        <p
                          className="text-[22px] font-extrabold leading-none"
                          style={{ color: currentPlanVisual.text }}
                        >
                          {tokenBalanceKnown ? tokenBalance.toLocaleString("fr-FR") : "—"}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2 text-right">
                        <button
                          type="button"
                          onClick={() => void load(true)}
                          className="flex items-center gap-1 text-[11px] font-semibold transition-colors hover:opacity-75"
                          style={{ color: currentPlanVisual.text }}
                        >
                          <RefreshCw size={11} /> Actualiser
                        </button>
                        <p className="text-[12px] font-semibold" style={{ color: currentPlanVisual.muted }}>
                          {tokenBalanceKnown
                            ? `Bonus Pro initial : ${tokenBonusUsed} utilisés / ${bonusTokenLimit}`
                            : tokenDataError
                              ? "Solde temporairement indisponible"
                              : "Solde indisponible"}
                        </p>
                      </div>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-indigo-100">
                      <div
                        className="h-full rounded-full"
                        style={{ width: tokenProgress, background: "linear-gradient(90deg,#5B5FEE,#A855F7)" }}
                      />
                    </div>
                    {tokenBalanceKnown && tokenBalance > bonusTokenLimit ? (
                      <p className="text-[11px] font-semibold text-emerald-600">
                        Solde total : {tokenBalance.toLocaleString("fr-FR")} jetons.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-xl border border-white/70 bg-white/70 px-4 py-3">
                    <p className="text-[13px] font-extrabold" style={{ color: currentPlanVisual.text }}>
                      Jetons de transmission réservés au plan Pro
                    </p>
                    <p className="mt-1 text-[12px] leading-5" style={{ color: currentPlanVisual.muted }}>
                      Le plan Starter n'inclut ni transmissions connectées ni achat de jetons. Vous pouvez continuer à
                      créer vos devis et factures PDF classiques.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {tokensEnabled ? (
            <div className="rounded-2xl border border-[#E8EAF0] bg-white px-6 py-5 shadow-sm flex flex-col gap-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-[13px] font-bold text-gray-900">Recharger des jetons</p>
                  <p className="text-[12px] mt-0.5 text-gray-500">
                    {subscriptionTrialing
                      ? `L’essai Pro de ${TRIAL_DAYS} jours est limité aux brouillons et prévisualisations : aucune émission définitive, aucun email client et aucune transmission Seqino réelle. Après souscription, la transmission reste soumise au contrat, au mandat et à la configuration du connecteur.`
                      : tokenTopupStatus === "enabled"
                        ? "Disponibles lorsque le connecteur de transmission est actif."
                        : tokenTopupMessage ||
                          "Les recharges restent indisponibles tant qu'aucun connecteur de transmission n'est actif."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setTokenHistoryPage(1);
                    setTokenHistoryOpen(true);
                  }}
                  className="inline-flex items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50 px-3.5 py-2 text-[12px] font-bold text-indigo-700 transition-all hover:border-indigo-200 hover:bg-indigo-100"
                >
                  <History size={13} />
                  Historique des jetons
                  <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-extrabold text-indigo-500">
                    {fullTokenHistory.length}
                  </span>
                </button>
              </div>

              {subscriptionTrialing ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] font-semibold text-amber-800">
                  L’essai Pro de {TRIAL_DAYS} jours n’inclut ni jetons, ni émission définitive, ni email client, ni
                  transmission réelle. Lors d’une souscription Pro disponible, les 50 jetons sont réservés puis crédités
                  une seule fois après activation et disponibilité du stock. Ils restent utilisables uniquement avec un
                  connecteur opérationnel.
                </div>
              ) : null}

              {visibleTokenPacks.length ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {visibleTokenPacks.map((pack: any) => {
                    const display = tokenPackDisplay(pack);
                    const packKey = String(pack.pack);
                    const active = selectedTokenPackKey === packKey;
                    const isBestPack = display.tokens === bestPackTokens;
                    return (
                      <button
                        key={pack.pack}
                        type="button"
                        onClick={() => setActiveTokenPackKey(packKey)}
                        aria-label={
                          pack?.checkout_enabled === false ? tokenPackDisabledLabel(pack) : tokenPackLabel(pack)
                        }
                        className={cn(
                          "relative rounded-2xl border-2 p-4 text-left transition-all duration-150",
                          active
                            ? "border-[#5B5FEE] bg-gradient-to-b from-indigo-50/70 to-white shadow-md shadow-indigo-100"
                            : "border-indigo-100 bg-indigo-50/45 shadow-sm hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-indigo-50 hover:shadow-md hover:shadow-indigo-100/70",
                        )}
                      >
                        {isBestPack && (
                          <span
                            className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[9px] font-extrabold text-white px-2 py-0.5 rounded-full whitespace-nowrap"
                            style={{ background: "linear-gradient(90deg,#5B5FEE,#8B5CF6)" }}
                          >
                            ✦ TOP
                          </span>
                        )}
                        <p
                          className={cn("text-[12px] font-semibold mb-1", active ? "text-indigo-700" : "text-gray-600")}
                        >
                          {display.tokens >= 1000 ? `${display.tokens / 1000}k` : display.tokens} jetons
                        </p>
                        <p
                          className={cn(
                            "text-[22px] font-extrabold leading-none",
                            active ? "text-[#5B5FEE]" : "text-gray-900",
                          )}
                        >
                          {display.amount ? `${display.amount}€` : "—"}
                        </p>
                        {active && (
                          <div
                            className="mt-2 w-4 h-4 rounded-full flex items-center justify-center ml-auto"
                            style={{ background: "#5B5FEE" }}
                          >
                            <Check size={9} className="text-white" strokeWidth={3} />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="col-span-2 lg:col-span-4 rounded-2xl border border-[#EEF0F8] bg-[#FAFBFE] px-4 py-8 text-center text-[12px] font-semibold text-gray-400">
                    {tokenDataError
                      ? "Packs temporairement indisponibles."
                      : "Aucun pack de jetons disponible pour le moment."}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-[#F0F3F8]">
                <div className="text-[12px] text-gray-500">
                  {selectedTokenDisplay ? (
                    <>
                      <span className="font-semibold text-gray-800">
                        {selectedTokenDisplay.tokens.toLocaleString("fr-FR")} jetons
                      </span>{" "}
                      ajoutés à votre solde pour{" "}
                      <span className="font-bold text-[#5B5FEE]">{selectedTokenDisplay.amount}€</span>
                    </>
                  ) : (
                    "Sélectionnez un pack pour acheter des jetons"
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={() => selectedTokenPack && void startTokenCheckout(selectedTokenPackKey)}
                    disabled={selectedTokenPackDisabled}
                    className="flex items-center gap-2 text-[13px] font-semibold text-white rounded-xl px-5 py-2.5 hover:opacity-90 hover:scale-[1.02] active:scale-[0.98] transition-all shadow-lg shadow-indigo-200/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
                    style={{ background: "linear-gradient(135deg,#5B5FEE,#7C3AED)" }}
                  >
                    <CreditCard size={13} />
                    {tokenCheckoutBusy === selectedTokenPackKey
                      ? "Ouverture..."
                      : selectedTokenPackCheckoutKnown && selectedTokenPack?.checkout_enabled === false
                        ? unavailableLabel(selectedTokenPack?.reason)
                        : `Acheter · ${selectedTokenDisplay?.amount || "—"}€`}
                  </button>
                  {!tokensEnabled ? (
                    <p className="text-right text-[11px] font-semibold text-amber-600">
                      {currentPlan === "starter"
                        ? "Disponible avec le plan Pro."
                        : "Recharge indisponible sur ce compte."}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-sky-200 bg-sky-50 px-5 py-4 text-[12px] leading-5 text-sky-900">
              <p className="font-bold">Achats, paiements et e-facturation non inclus dans Starter</p>
              <p className="mt-1">
                Votre espace Starter reste limité aux clients, devis, factures PDF, paramètres et exports classiques.
                Passez au plan Pro pour accéder aux achats, au suivi des paiements et aux fonctions d'e-facturation.
              </p>
            </div>
          )}

          <div id="billing-plans" className="space-y-4">
            <div className="flex justify-end">
              <div className="flex items-center p-1 bg-[#EFF1F7] rounded-xl gap-0.5">
                {(["monthly", "yearly"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPeriod(value)}
                    className={cn(
                      "px-4 py-1.5 rounded-lg text-[12px] font-semibold transition-all capitalize flex items-center gap-1.5",
                      period === value ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700",
                    )}
                  >
                    {value === "monthly" ? "Mensuel" : "Annuel"}
                    {value === "yearly" && period !== value && (
                      <span className="text-[10px] font-bold text-emerald-600">-17%</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
              {resolvedPlans.map((planItem) => {
                const isPro = planItem.id === "pro";
                const isEnterprise = planItem.id === "enterprise";
                const planAccent = isPro
                  ? {
                      bar: "#7c3aed",
                      surface: "#f5f3ff",
                      icon: "#7c3aed",
                      price: "#4338CA",
                      checkBg: "bg-indigo-100",
                      checkText: "text-[#4F46E5]",
                      button: "#6d28d9",
                      border: "#8b5cf6",
                      ring: "ring-1 ring-[#6366F1]/25 shadow-xl shadow-indigo-200/60",
                    }
                  : isEnterprise
                    ? {
                        bar: "#0f766e",
                        surface: "#ffffff",
                        icon: "#0f766e",
                        price: "#0F766E",
                        checkBg: "bg-emerald-100",
                        checkText: "text-[#0F766E]",
                        button: "#0f766e",
                        border: "#a7f3d0",
                        ring: "shadow-lg shadow-emerald-100",
                      }
                    : {
                        bar: "#0284c7",
                        surface: "#ffffff",
                        icon: "#0284c7",
                        price: "#0369a1",
                        checkBg: "bg-sky-100",
                        checkText: "text-[#0284C7]",
                        button: "#0284c7",
                        border: "#7dd3fc",
                        ring: "shadow-xl shadow-sky-100",
                      };
                const selectedPrice = period === "yearly" ? planItem.priceYearly : planItem.priceMonthly;
                const selectedCheckout = checkoutAvailabilityForPlan(planItem.id);
                const selectedAvailability = selectedCheckout.availability;
                const selectedReason = selectedCheckout.reason;
                const monthlyAmount = amountNumber(planItem.priceMonthly);
                const yearlyAmount = amountNumber(planItem.priceYearly);
                const discount =
                  period === "yearly" && monthlyAmount > 0 && yearlyAmount > 0
                    ? Math.round((1 - yearlyAmount / (monthlyAmount * 12)) * 100)
                    : 0;
                const isCurrentPlan = currentPlan === planItem.id;
                const isTrialActivation = subscriptionTrialing && isCurrentPlan && !isEnterprise;
                const requiresPlanChangeSupport = Boolean(
                  normalizedSubscriptionStatus === "active" && currentPlan && !isCurrentPlan && !isEnterprise,
                );
                const PlanIcon = isPro ? Sparkles : isEnterprise ? TrendingUp : Building2;
                const featureList = isEnterprise
                  ? ["Contrat adapté", "Volumétrie sur mesure", "Accompagnement dédié", "Support prioritaire"]
                  : planItem.features;
                const ctaLabel = isTrialActivation
                  ? `Activer ${planItem.name}`
                  : isCurrentPlan
                    ? "Plan actuel"
                    : isEnterprise || requiresPlanChangeSupport || selectedAvailability === "contact"
                      ? "Nous contacter"
                      : selectedAvailability === "checkout"
                        ? `Choisir ${planItem.name}`
                        : unavailableLabel(selectedReason);

                return (
                  <div
                    key={planItem.id}
                    className={cn(
                      "relative flex min-h-[520px] flex-col overflow-hidden rounded-2xl border border-[#E8EAF0] bg-white transition-all hover:-translate-y-0.5 hover:shadow-xl",
                      planAccent.ring,
                    )}
                    style={{ borderColor: planAccent.border }}
                  >
                    <div className="h-[3px]" style={{ background: planAccent.bar }} />
                    <div className="flex flex-1 flex-col gap-7 p-7 xl:p-8" style={{ background: planAccent.surface }}>
                      <div className="space-y-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div
                              className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-sm"
                              style={{ background: planAccent.icon }}
                            >
                              <PlanIcon size={16} />
                            </div>
                            <span className="font-extrabold text-[16px] text-gray-900">{planItem.name}</span>
                          </div>
                        </div>
                        <p className="min-h-[48px] text-[13px] leading-6 text-gray-500">
                          {period === "yearly" && planItem.yearlyDesc ? planItem.yearlyDesc : planItem.desc}
                        </p>
                      </div>

                      {isEnterprise ? (
                        <div className="py-1">
                          <p className="text-[32px] font-extrabold leading-none" style={{ color: planAccent.price }}>
                            Sur devis
                          </p>
                          <p className="mt-2 text-[12px] font-semibold text-gray-500">
                            Contrat et accompagnement adaptés.
                          </p>
                        </div>
                      ) : (
                        <div>
                          <div className="flex items-end gap-1">
                            <span
                              className="text-[44px] font-extrabold leading-none"
                              style={{ color: planAccent.price }}
                            >
                              {selectedPrice}€
                            </span>
                            <span className="text-[13px] text-gray-500 pb-2">
                              /{period === "yearly" ? "an" : "mois"}
                            </span>
                          </div>
                          {period === "yearly" && discount > 0 && (
                            <p className="text-[12px] text-emerald-600 font-bold mt-2">
                              Économisez {discount}% par rapport au mensuel
                            </p>
                          )}
                        </div>
                      )}

                      <ul className="space-y-3.5 flex-1">
                        {featureList.map((feature: string) => (
                          <li key={feature} className="flex items-start gap-3 text-[13px] leading-5 text-gray-600">
                            <div
                              className={cn(
                                "w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5",
                                planAccent.checkBg,
                                planAccent.checkText,
                              )}
                            >
                              <Check size={8} strokeWidth={3} />
                            </div>
                            {feature}
                          </li>
                        ))}
                      </ul>

                      {isEnterprise || requiresPlanChangeSupport || selectedAvailability === "contact" ? (
                        <Link
                          to="/contact"
                          className={cn(
                            "w-full py-3.5 rounded-xl text-[13px] font-bold transition-all text-center",
                            isEnterprise || isPro
                              ? "text-white shadow-lg hover:opacity-90"
                              : "text-white hover:opacity-90",
                          )}
                          style={{ background: planAccent.button }}
                        >
                          {ctaLabel}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          disabled={
                            (!isTrialActivation && isCurrentPlan) ||
                            loading ||
                            selectedAvailability !== "checkout" ||
                            busyPlan === planItem.id
                          }
                          onClick={() => void startCheckout(planItem.id)}
                          className={cn(
                            "w-full py-3.5 rounded-xl text-[13px] font-bold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55",
                            isPro ? "shadow-lg shadow-indigo-200/50" : "shadow-lg shadow-slate-200/60",
                          )}
                          style={{ background: planAccent.button }}
                        >
                          {busyPlan === planItem.id ? "Ouverture..." : ctaLabel}
                        </button>
                      )}
                      {!isCurrentPlan && selectedAvailability !== "checkout" && selectedCheckout.message ? (
                        <p className="text-center text-[11px] font-semibold leading-4 text-amber-700" role="status">
                          {selectedCheckout.message}
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-[#E8EAF0] bg-white shadow-sm">
            <div className="border-b border-[#F3F5F9] px-5 py-4">
              <p className="text-[13px] font-extrabold text-gray-900">Détails inclus</p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[680px] w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#F0F3F8]">
                    <th className="text-left px-6 py-4 text-[11px] font-bold text-gray-400 uppercase tracking-wider w-[42%]">
                      Fonctionnalité
                    </th>
                    {planOrder.map((id) => (
                      <th
                        key={id}
                        className={cn(
                          "text-center px-4 py-4 font-bold text-[13px]",
                          id === "pro" ? "text-[#5B5FEE] bg-indigo-50/60" : "text-gray-700",
                        )}
                      >
                        {id === "starter" ? "Starter" : id === "pro" ? "Pro" : "Volume"}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {planComparisonRows.map((row, i) => (
                    <tr key={row.label} className={cn("border-b border-[#F0F3F8]", i % 2 === 1 && "bg-[#FAFBFE]")}>
                      <td className="px-6 py-3.5 font-medium text-gray-700">{row.label}</td>
                      {planOrder.map((id) => {
                        const value = row[id];
                        return (
                          <td key={id} className={cn("text-center px-4 py-3.5", id === "pro" && "bg-indigo-50/30")}>
                            {value === true ? (
                              <Check size={15} className="inline text-emerald-500" strokeWidth={2.5} />
                            ) : value === false ? (
                              <span className="inline-block w-4 h-px bg-gray-200 align-middle" />
                            ) : (
                              <span className="text-[12px] font-semibold text-gray-600">{value}</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {tokenHistoryOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4 py-6">
          <button
            type="button"
            aria-label="Fermer l'historique"
            className="absolute inset-0 cursor-default"
            onClick={() => setTokenHistoryOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="token-history-title"
            className="relative z-10 max-h-[86vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-[#E8EAF0] bg-white shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#F3F5F9] px-6 py-4">
              <div>
                <p id="token-history-title" className="text-[16px] font-extrabold text-gray-900">
                  Historique des jetons
                </p>
                <p className="mt-0.5 text-[12px] text-gray-500">Consommations, achats et bonus de jetons.</p>
              </div>
              <button
                type="button"
                aria-label="Fermer"
                onClick={() => setTokenHistoryOpen(false)}
                className="rounded-xl border border-[#E8EAF0] p-2 text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
              {hasTokenHistory ? (
                <div className="divide-y divide-[#F7F8FC]">
                  {paginatedTokenHistory.map((entry: any) => {
                    const delta = Number(entry.delta || 0);
                    const detail = entry.detail || {};
                    const isUsage = delta < 0;
                    const detailDate = detail.issue_date ? formatLedgerDate(detail.issue_date) : null;
                    const movementDate = formatLedgerDate(entry.created_at);
                    const amount = detail.amount_ttc ? `${detail.amount_ttc} ${detail.currency || "EUR"}` : null;
                    const title =
                      detail.label || (isUsage ? "Consommation de jeton" : ledgerTypeLabel(String(entry.type || "")));
                    const inlineMetaParts = [
                      detail.customer_name || null,
                      detail.period_label || null,
                      detail.event_type || null,
                      detailDate,
                      amount,
                    ].filter(Boolean);
                    return (
                      <div
                        key={entry.id || `${entry.reference_type}-${entry.reference_id}`}
                        className="grid gap-3 py-3.5 sm:grid-cols-[1fr_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold",
                                isUsage ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700",
                              )}
                            >
                              {ledgerBadgeLabel(entry)}
                            </span>
                            <span className="text-[11px] font-medium text-gray-400">{movementDate}</span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <p className="min-w-0 truncate text-[13px] font-bold text-gray-900">{title}</p>
                            {inlineMetaParts.length ? (
                              <span className="text-[12px] font-semibold text-[#4F46E5]">
                                {inlineMetaParts.join(" · ")}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-3">
                          {detail.href ? (
                            <Link
                              to={detail.href}
                              className="text-[12px] font-semibold text-[#5B5FEE] hover:text-indigo-800"
                              onClick={() => setTokenHistoryOpen(false)}
                            >
                              Ouvrir
                            </Link>
                          ) : null}
                          <span
                            className={cn("text-[16px] font-extrabold", isUsage ? "text-red-600" : "text-emerald-600")}
                          >
                            {delta > 0 ? "+" : ""}
                            {delta}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-[#E8EAF0] bg-[#FAFBFE] px-6 py-10 text-center">
                  <p className="text-[13px] font-semibold text-gray-500">Aucun mouvement de jetons enregistré.</p>
                </div>
              )}
            </div>

            {hasTokenHistory && tokenHistoryPageCount > 1 ? (
              <div className="flex items-center justify-between gap-3 border-t border-[#F3F5F9] px-6 py-3">
                <p className="text-[11px] font-medium text-gray-500">
                  {((safeTokenHistoryPage - 1) * TOKEN_HISTORY_PAGE_SIZE + 1).toLocaleString("fr-FR")}-
                  {Math.min(safeTokenHistoryPage * TOKEN_HISTORY_PAGE_SIZE, fullTokenHistory.length).toLocaleString(
                    "fr-FR",
                  )}{" "}
                  sur {fullTokenHistory.length.toLocaleString("fr-FR")}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={safeTokenHistoryPage <= 1}
                    onClick={() => setTokenHistoryPage((page) => Math.max(1, page - 1))}
                    className="rounded-lg border border-[#E8EAF0] px-3 py-1.5 text-[12px] font-semibold text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Précédent
                  </button>
                  <span className="min-w-16 text-center text-[12px] font-bold text-gray-700">
                    {safeTokenHistoryPage} / {tokenHistoryPageCount}
                  </span>
                  <button
                    type="button"
                    disabled={safeTokenHistoryPage >= tokenHistoryPageCount}
                    onClick={() => setTokenHistoryPage((page) => Math.min(tokenHistoryPageCount, page + 1))}
                    className="rounded-lg border border-[#E8EAF0] px-3 py-1.5 text-[12px] font-semibold text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Suivant
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

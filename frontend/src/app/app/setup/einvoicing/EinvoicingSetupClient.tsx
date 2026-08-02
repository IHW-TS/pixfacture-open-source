"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import OfficialSourcesCallout from "@/components/OfficialSourcesCallout";
import AppPageHeader from "@/components/AppPageHeader";
import EinvoicingDisclaimer from "@/components/EinvoicingDisclaimer";
import { api, apiFetch, formatApiError, sanitizeUserFacingApiMessage } from "@/lib/api";
import { formatDateTimeFr } from "@/lib/dateFormat";
import { pdpIntegrationEnabled, ppfDirectoryEnabled } from "@/lib/featureFlags";
import { PLATFORM_LABEL_LONG } from "@/lib/terminology";
import { useSession } from "@/lib/useSession";
import styles from "./EinvoicingSetupClient.module.css";

type ReadinessCheck = {
  id: string;
  status: "ok" | "missing" | "error" | "todo" | "roadmap" | "na";
  action_url?: string | null;
  missing_fields?: string[];
  provider?: string | null;
  last_status?: string | null;
};

type ReadinessResponse = {
  overall_status: "ready" | "partial" | "not_ready";
  checks: ReadinessCheck[];
  prerequisites: string[];
};

type OnboardingError = {
  code: string;
  message: string;
  hint?: string | null;
};

type OnboardingStatus = {
  enabled_connectors: {
    seqino: boolean;
    chorus: boolean;
    generic_http: boolean;
  };
  mandate: {
    required: boolean;
    active_count: number;
    last_updated: string | null;
  };
  directory: {
    last_sync: string | null;
    status: "ok" | "error" | "never";
    error: string | null;
  };
  exchanges: {
    last_success: string | null;
    last_error: string | null;
    error_summary: string | null;
  };
  errors: OnboardingError[];
};

const DEFAULT_PREREQUISITES = [
  "SIRET de l'émetteur",
  "SIREN des clients (à partir du SIRET)",
  "Catégorie d'opération (biens/services/mixte)",
  "Adresse de livraison si différente",
];

const STATUS_LABELS: Record<string, string> = {
  ok: "OK",
  missing: "À faire",
  error: "Erreur",
  todo: "À faire",
  roadmap: "Roadmap",
  na: "Non requis",
};

const STATUS_CLASS: Record<string, string> = {
  ok: "status-pill status-active",
  missing: "status-pill status-danger",
  error: "status-pill status-danger",
  todo: "status-pill status-warning",
  roadmap: "status-pill status-muted",
  na: "status-pill status-muted",
};

const WIZARD_STATUS_LABELS: Record<string, string> = {
  ok: "OK",
  missing: "À faire",
  error: "Erreur",
  todo: "À faire",
  roadmap: "Roadmap",
  na: "Non requis",
};

const WIZARD_STATUS_CLASS: Record<string, string> = {
  ok: "status-pill status-active",
  missing: "status-pill status-warning",
  error: "status-pill status-danger",
  todo: "status-pill status-warning",
  roadmap: "status-pill status-muted",
  na: "status-pill status-muted",
};

const TECH_STATUS_LABELS: Record<string, string> = {
  ok: "OK",
  error: "KO",
  never: "Jamais",
};

const TECH_STATUS_CLASS: Record<string, string> = {
  ok: "status-pill status-active",
  error: "status-pill status-danger",
  never: "status-pill status-muted",
};

const CHECK_LABELS: Record<string, string> = {
  company_profile: "Profil entreprise",
  pdp_connection: "Connexion Seqino",
  sandbox_test: "Test de transmission",
  e_reporting: "E-reporting",
};

const FIELD_LABELS: Record<string, string> = {
  name: "Nom légal",
  siret: "SIRET",
  vat_number: "TVA",
  address: "Adresse",
  postal_code: "Code postal",
  city: "Ville",
  country: "Pays",
  payments_reporting_enabled: "Activation e-reporting paiements",
  transaction_periodicity: "Périodicité transactions",
  payment_periodicity: "Périodicité paiements",
};

const formatMissingFields = (fields?: string[]) => {
  if (!fields || fields.length === 0) return "";
  return fields.map((field) => FIELD_LABELS[field] || field).join(", ");
};

const formatDateTime = (value?: string | null) => formatDateTimeFr(value, "-");

const QUICK_ACCESS_LINKS = [
  {
    label: "Synchronisation Seqino",
    href: "/app/einvoicing",
    hint: "Vérifier la synchronisation des destinataires via Seqino",
    requires: "pdp",
  },
  {
    label: "Transmissions",
    href: "/app/transmissions",
    hint: "Suivre les envois",
    requires: "pdp",
  },
  {
    label: "Achats & fournisseurs",
    href: "/app/purchases",
    hint: "Réception fournisseurs",
    requires: "pdp",
  },
  {
    label: "E-reporting",
    href: "/app/e-reporting",
    hint: "Données B2C/paiements",
    requires: "pdp",
  },
];

const CONTACT_URL = "/contact";
const EXPORT_MODE_ID = "mode-export";
const CONNECTED_MODE_ID = "mode-connecte";
const EXPORT_DESTINATION = "/app/invoices/new";
const CONNECTED_DESTINATION = "/app/einvoicing";

const isBillingBlocked = (status: string | null) => {
  const normalized = (status || "").toLowerCase().trim();
  return ["canceled", "past_due"].includes(normalized);
};

export default function EinvoicingSetupClient() {
  const searchParams = useSearchParams();
  const { user, subscriptionStatus, capabilities, loading: sessionLoading } = useSession();
  const router = useRouter();
  const notice = searchParams.get("notice");
  const [exportReadiness, setExportReadiness] = useState<ReadinessResponse | null>(null);
  const [connectedReadiness, setConnectedReadiness] = useState<ReadinessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null);
  const [onboardingLoading, setOnboardingLoading] = useState(true);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [tokenState, setTokenState] = useState<any>(null);
  const role = (user?.role || "").toLowerCase();
  const isTenantAdmin = user?.is_admin === true || role === "owner" || role === "admin";
  const showBillingCallout = isTenantAdmin && isBillingBlocked(subscriptionStatus);
  const einvoicingEnabled = Boolean(capabilities?.einvoicing_enabled);

  const trackOnboardingEvent = useCallback(
    async (payload: { event: string; mode?: "export" | "connected"; reason?: string | null; source?: string }) => {
      try {
        await apiFetch("/api/platforms/onboarding-event", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } catch {
        // Ignore tracking failures.
      }
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!einvoicingEnabled) {
          const exportData = await api("/api/einvoicing/readiness?mode=export", {});
          if (mounted) {
            setExportReadiness(exportData as ReadinessResponse);
            setConnectedReadiness(null);
          }
          return;
        }
        const [exportData, connectedData] = await Promise.all([
          api("/api/einvoicing/readiness?mode=export", {}),
          api("/api/einvoicing/readiness?mode=connected", {}),
        ]);
        if (mounted) {
          setExportReadiness(exportData as ReadinessResponse);
          setConnectedReadiness(connectedData as ReadinessResponse);
        }
      } catch (err: any) {
        if (mounted) {
          setExportReadiness(null);
          setConnectedReadiness(null);
          setError(formatApiError(err, "Impossible de charger la checklist e-invoicing."));
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [einvoicingEnabled]);

  useEffect(() => {
    if (!capabilities?.token_topup_enabled) {
      setTokenState(null);
      return;
    }
    let mounted = true;
    const load = async () => {
      try {
        const data = await api("/api/tokens/state", {});
        if (mounted) {
          setTokenState(data || null);
        }
      } catch {
        if (mounted) {
          setTokenState(null);
        }
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [capabilities?.token_topup_enabled]);

  useEffect(() => {
    if (!einvoicingEnabled) {
      setOnboardingStatus(null);
      setOnboardingLoading(false);
      setOnboardingError(null);
      return;
    }
    let mounted = true;
    const load = async () => {
      setOnboardingLoading(true);
      setOnboardingError(null);
      try {
        const data = await api("/api/platforms/onboarding-status", {});
        if (mounted) {
          setOnboardingStatus(data as OnboardingStatus);
        }
      } catch (err: any) {
        if (mounted) {
          setOnboardingStatus(null);
          setOnboardingError(formatApiError(err, "Impossible de charger le statut d'activation."));
        }
      } finally {
        if (mounted) setOnboardingLoading(false);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [einvoicingEnabled]);

  const readiness = connectedReadiness || exportReadiness;
  const prerequisites = readiness?.prerequisites || DEFAULT_PREREQUISITES;
  const checks = readiness?.checks || [];
  const exportOverallStatus = exportReadiness?.overall_status || "not_ready";
  const connectedOverallStatus = connectedReadiness?.overall_status || "not_ready";
  const exportOverallLabel = exportOverallStatus === "ready" ? "Prêt" : "À faire";
  const connectedOverallLabel = connectedOverallStatus === "ready" ? "Prêt" : "Non prêt";
  const exportOverallClass =
    exportOverallStatus === "ready" ? "status-pill status-active" : "status-pill status-warning";
  const connectedOverallClass =
    connectedOverallStatus === "ready" ? "status-pill status-active" : "status-pill status-danger";

  const quickLinks = QUICK_ACCESS_LINKS.filter((item) => {
    if (item.requires === "ppf" && !ppfDirectoryEnabled) return false;
    if (item.requires === "pdp" && !pdpIntegrationEnabled) return false;
    return true;
  });
  const companyCheck = checks.find((check) => check.id === "company_profile");
  const sandboxCheck = checks.find((check) => check.id === "sandbox_test");
  const connectors = onboardingStatus?.enabled_connectors;
  const connectorsEnabled = Boolean(connectors?.seqino || connectors?.chorus || connectors?.generic_http);
  const connectorLabels = [
    connectors?.seqino ? "Seqino" : null,
    connectors?.chorus ? "Canal public" : null,
    connectors?.generic_http ? "HTTP générique" : null,
  ].filter(Boolean) as string[];
  const connectorSummary = connectorLabels.length
    ? `Activation connecteur : ${connectorLabels.join(", ")}`
    : "Aucune activation connecteur.";
  const mandateRequired = Boolean(onboardingStatus?.mandate.required);
  const mandateActiveCount = onboardingStatus?.mandate.active_count || 0;
  const mandateLastUpdated = onboardingStatus?.mandate.last_updated || null;
  const mandateDetailBase = mandateRequired
    ? mandateActiveCount > 0
      ? `${mandateActiveCount} mandat actif`
      : "Aucun mandat actif"
    : "Mandat requis uniquement si mode sponsor activé.";
  const mandateDetail = mandateLastUpdated
    ? `${mandateDetailBase} · MAJ: ${formatDateTime(mandateLastUpdated)}`
    : mandateDetailBase;
  const directoryStatus = onboardingStatus?.directory.status || "never";
  const directoryLabel = TECH_STATUS_LABELS[directoryStatus] || directoryStatus;
  const directoryClass = TECH_STATUS_CLASS[directoryStatus] || TECH_STATUS_CLASS.never;
  const exchangeLastSuccess = onboardingStatus?.exchanges.last_success || null;
  const exchangeLastError = onboardingStatus?.exchanges.last_error || null;
  const exchangeErrorSummary = onboardingStatus?.exchanges.error_summary || null;
  const exchangeStatus = exchangeLastSuccess ? "ok" : exchangeLastError ? "error" : "never";
  const exchangeLabel = TECH_STATUS_LABELS[exchangeStatus] || exchangeStatus;
  const exchangeClass = TECH_STATUS_CLASS[exchangeStatus] || TECH_STATUS_CLASS.never;
  const companyStatus = companyCheck?.status || "todo";
  const connectorStatus = connectorsEnabled ? "ok" : "missing";
  const mandateStatus = !mandateRequired ? "na" : mandateActiveCount > 0 ? "ok" : "missing";
  const sandboxStatus = sandboxCheck?.status || "todo";
  const onboardingErrors = onboardingStatus?.errors || [];
  const normalizedErrors = onboardingErrors.map((item) => ({
    ...item,
    normalizedCode: (item.code || "").toLowerCase().trim(),
  }));
  const seqinoBlocker = normalizedErrors.find(
    (item) =>
      item.normalizedCode === "seqino_mandate_missing" ||
      item.normalizedCode === "mandate_missing" ||
      item.normalizedCode === "seqino_not_ready",
  );
  const exportReason = seqinoBlocker?.normalizedCode || null;
  const showExportFallback = Boolean(seqinoBlocker);
  const exportFallbackMessage =
    seqinoBlocker?.normalizedCode === "seqino_not_ready"
      ? "Le mode connecté est temporairement indisponible."
      : "Le mode connecté est bloqué tant que le mandat Seqino n’est pas signé.";
  const exportFallbackHint = seqinoBlocker?.hint ? sanitizeUserFacingApiMessage(seqinoBlocker.hint, 400, "") : null;
  const connectedDisabled = !pdpIntegrationEnabled;
  const wizardSteps = [
    {
      id: "company_profile",
      title: "Étape A — Profil entreprise complet",
      status: companyStatus,
      description: "SIREN/SIRET, TVA, adresse et infos légales.",
      detail: formatMissingFields(companyCheck?.missing_fields),
      actionLabel: "Compléter le profil",
      actionUrl: companyCheck?.action_url || "/app/company",
    },
    {
      id: "connector",
      title: "Étape B — Activer Seqino",
      status: connectorStatus,
      description: "Contractualisation requise avec Seqino. PixFacture reste le logiciel de facturation.",
      detail: connectorSummary,
      actionLabel: connectorsEnabled ? "Voir l’activation" : "Activer Seqino",
      actionUrl: "/app/einvoicing",
    },
    {
      id: "mandate",
      title: "Étape C — Mandat",
      status: mandateStatus,
      description: "Requis pour activer la réception et les statuts via Seqino.",
      detail: mandateDetail,
      actionLabel: mandateRequired ? (mandateActiveCount > 0 ? "Voir les mandats" : "Activer / signer") : "",
      actionUrl: mandateRequired ? "/app/einvoicing" : "",
    },
    {
      id: "sandbox",
      title: "Étape D — Test de transmission",
      status: sandboxStatus,
      description: "Valider un échange dans l’environnement de test.",
      detail: sandboxCheck?.last_status ? `Dernier statut: ${sandboxCheck.last_status}` : "",
      actionLabel: "Lancer un test",
      actionUrl: sandboxCheck?.action_url || "/app/einvoicing",
    },
  ];
  const showActivationCta = wizardSteps.some((step) => !["ok", "na"].includes(step.status));
  const tokenBalance = Number(tokenState?.balance || 0);
  const showTokenTopupCallout = Boolean(capabilities?.token_topup_enabled) && tokenBalance <= 0;

  const handleExportMode = useCallback(() => {
    void trackOnboardingEvent({
      event: "einvoicing_onboarding_choice",
      mode: "export",
      reason: exportReason,
      source: "einvoicing_setup",
    });
    router.push(EXPORT_DESTINATION);
  }, [exportReason, router, trackOnboardingEvent]);

  const handleConnectedMode = useCallback(() => {
    if (!einvoicingEnabled) {
      router.push("/app/billing");
      return;
    }
    if (connectedDisabled) return;
    void trackOnboardingEvent({
      event: "einvoicing_onboarding_choice",
      mode: "connected",
      source: "einvoicing_setup",
    });
    router.push(CONNECTED_DESTINATION);
  }, [connectedDisabled, einvoicingEnabled, router, trackOnboardingEvent]);

  if (loading || onboardingLoading || sessionLoading) {
    return (
      <div className="app-main">
        <div className="card">Chargement du statut d'activation...</div>
      </div>
    );
  }

  return (
    <div className="app-main">
      <AppPageHeader
        title="Préparer la facturation électronique (2026-2027)"
        subtitle="Paramètres > E-facturation"
        backHref="/app/settings"
        actions={
          <div className="row gap-8 items-center flex-wrap">
            <span className={exportOverallClass}>Mode export : {exportOverallLabel}</span>
            <span className={connectedOverallClass}>Mode connecté : {connectedOverallLabel}</span>
          </div>
        }
      />
      <EinvoicingDisclaimer />
      <p className="muted mt-10 mb-0">
        Checklist guidée pour savoir ce qu'il faut préparer, ce qui est déjà en place, et ce qui reste à faire.
      </p>

      {notice && <div className="alert-inline warning mt-12">{notice}</div>}

      {error && <div className="alert-inline danger mt-12">{error}</div>}

      {onboardingError && <div className="alert-inline danger mt-12">{onboardingError}</div>}

      {showBillingCallout && (
        <div className="alert-inline warning mt-12 flex items-center gap-12 flex-wrap">
          <div>Abonnement inactif : certaines actions seront bloquées.</div>
          <a className="btn secondary" href="/app/billing">
            Réactiver l'abonnement
          </a>
        </div>
      )}

      {!einvoicingEnabled && (
        <div className="alert-inline warning mt-12 flex items-center gap-12 flex-wrap">
          <div>
            Starter conserve la facturation classique sans Chorus, Seqino ni e-facturation active. Le mode connecté est
            disponible à partir du plan Pro.
          </div>
          <a className="btn secondary" href="/app/billing">
            Passer au plan Pro
          </a>
        </div>
      )}

      {showTokenTopupCallout && (
        <div className="alert-inline warning mt-12 flex items-center gap-12 flex-wrap">
          <div>
            Solde insuffisant : il ne reste plus de jetons pour une transmission connectée. Rechargez votre solde avant
            le prochain envoi.
          </div>
          <a className="btn secondary" href="/app/billing">
            Acheter un pack
          </a>
        </div>
      )}

      {showExportFallback && (
        <div className="alert-inline warning mt-12 flex items-center gap-12 flex-wrap">
          <div>
            <div>{exportFallbackMessage}</div>
            {exportFallbackHint && <div className="muted">{exportFallbackHint}</div>}
          </div>
          <a className="btn secondary" href={`#${EXPORT_MODE_ID}`}>
            Passer en mode export
          </a>
        </div>
      )}

      <section className="section">
        <div className="section-header">
          <div>
            <h3 className="m-0">Parcours de préparation en 4 étapes</h3>
            <p className="muted">La durée dépend du dossier entreprise et des validations externes.</p>
          </div>
          <span className="pill muted">4 étapes</span>
        </div>
        <div className="card">
          <ol className="m-0 pl-20 list-gap-8">
            <li>Compléter le profil entreprise (SIRET, TVA, adresse).</li>
            <li>Contractualiser et configurer le raccordement Seqino.</li>
            <li>Signer le mandat requis.</li>
            <li>Valider un test dans l’environnement prévu à cet effet.</li>
          </ol>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <div>
            <h3 className="m-0">Choisir votre mode de démarrage</h3>
            <p className="muted">Démarrez sans mandat, puis activez le mode connecté quand vous êtes prêt.</p>
          </div>
          <span className="pill muted">Démarrage</span>
        </div>
        <div className="grid-cols-auto-260 gap-12">
          <div className="card grid-simple gap-8" id={EXPORT_MODE_ID}>
            <div className="row justify-between items-center gap-8">
              <div className="font-700">Mode export (recommandé pour démarrer)</div>
              <span className={exportOverallClass}>{exportOverallLabel}</span>
            </div>
            <div className="muted">Exportez Factur-X + PDF et transmettez depuis votre {PLATFORM_LABEL_LONG}.</div>
            <ul className="muted m-0 pl-18">
              <li>Démarrez immédiatement sans mandat.</li>
              <li>Vos factures restent utilisables sans connexion.</li>
              <li>Activez le mode connecté plus tard.</li>
            </ul>
            <div className="row gap-8">
              <button className="btn" type="button" onClick={handleExportMode}>
                Continuer sans plateforme
              </button>
              <span className="muted small">Vous pourrez activer le mode connecté ensuite.</span>
            </div>
          </div>
          <div className="card grid-simple gap-8" id={CONNECTED_MODE_ID}>
            <div className="row justify-between items-center gap-8">
              <div className="font-700">Mode connecté — {PLATFORM_LABEL_LONG}</div>
              <span className={!einvoicingEnabled ? "status-pill status-warning" : connectedOverallClass}>
                {!einvoicingEnabled ? "Plan Pro requis" : connectedOverallLabel}
              </span>
            </div>
            <div className="muted">
              Connexion via un partenaire {PLATFORM_LABEL_LONG}. Notre logiciel n’est pas une PA.
            </div>
            <ul className="muted m-0 pl-18">
              <li>Mandat actif signé avec Seqino.</li>
              <li>Profil entreprise complet (SIRET, TVA, adresse).</li>
              <li>Plan Pro actif.</li>
            </ul>
            <div className="row gap-8">
              <button
                className="btn"
                type="button"
                onClick={handleConnectedMode}
                disabled={connectedDisabled && einvoicingEnabled}
              >
                {einvoicingEnabled ? "Activer le mode connecté" : "Passer au plan Pro"}
              </button>
              {!einvoicingEnabled ? (
                <span className="muted small">
                  Starter reste limité à la facturation classique. Chorus, Seqino et l'e-facturation demandent le plan
                  Pro.
                </span>
              ) : connectedDisabled ? (
                <span className="muted small">Mode connecté indisponible dans cet environnement.</span>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <div>
            <h3 className="m-0">Mandat Seqino : qui signe quoi ?</h3>
            <p className="muted">Le mandat autorise Seqino à transmettre et recevoir les factures en votre nom.</p>
          </div>
          <span className="pill muted">Mandat</span>
        </div>
        <div className="card grid-simple gap-8">
          <div>Le mandat est signé par le représentant légal de votre entreprise et par Seqino.</div>
          <div className="muted">
            Il formalise l'autorisation d'émettre et de recevoir via Seqino.
            <a href="/legal/mentions-legales"> Consulter les mentions légales</a>.
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <div>
            <h3 className="m-0">Activation Seqino en 4 étapes</h3>
            <p className="muted">Chaque étape doit être confirmée ; aucun délai d’activation n’est garanti.</p>
          </div>
          <span className="pill muted">Wizard</span>
        </div>
        <div className={`card ${styles.wizardCard}`}>
          {wizardSteps.map((step) => {
            const statusLabel = WIZARD_STATUS_LABELS[step.status] || step.status;
            const statusClass = WIZARD_STATUS_CLASS[step.status] || WIZARD_STATUS_CLASS.todo;
            const showAction = step.actionUrl && step.status !== "ok" && step.status !== "na";
            return (
              <div key={step.id} className={`row ${styles.wizardRow}`}>
                <div className={styles.wizardStepMeta}>
                  <div className={styles.wizardStepTitle}>{step.title}</div>
                  <div className="muted">{step.description}</div>
                  {step.detail && <div className="muted">Détail: {step.detail}</div>}
                </div>
                <div className={`row ${styles.wizardActions}`}>
                  <span className={statusClass}>{statusLabel}</span>
                  {showAction && (
                    <a className="btn secondary" href={step.actionUrl}>
                      {step.actionLabel || "Configurer"}
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className={`card ${styles.wizardMetaCard}`}>
          <div className={`row ${styles.wizardMetaRow}`}>
            <div>
              <div className={styles.wizardMetaTitle}>Synchro Seqino</div>
              <div className="muted">Dernière synchro: {formatDateTime(onboardingStatus?.directory.last_sync)}</div>
              {onboardingStatus?.directory.error && (
                <div className="muted">
                  Synchronisation à reprendre :{" "}
                  {sanitizeUserFacingApiMessage(
                    onboardingStatus.directory.error,
                    400,
                    "La synchronisation de l'annuaire n'a pas abouti.",
                  )}
                </div>
              )}
            </div>
            <span className={directoryClass} data-testid="directory-status" data-status={directoryStatus}>
              {directoryLabel}
            </span>
          </div>
          <div className={`row ${styles.wizardMetaRow}`}>
            <div>
              <div className={styles.wizardMetaTitle}>Dernier échange</div>
              {exchangeLastSuccess && <div className="muted">OK: {formatDateTime(exchangeLastSuccess)}</div>}
              {!exchangeLastSuccess && exchangeLastError && (
                <div className="muted">
                  Erreur: {formatDateTime(exchangeLastError)}
                  {exchangeErrorSummary
                    ? ` · ${sanitizeUserFacingApiMessage(
                        exchangeErrorSummary,
                        400,
                        "Le dernier échange n'a pas abouti.",
                      )}`
                    : ""}
                </div>
              )}
              {!exchangeLastSuccess && !exchangeLastError && <div className="muted">Aucun échange enregistré.</div>}
            </div>
            <span className={exchangeClass} data-testid="exchange-status">
              {exchangeLabel}
            </span>
          </div>
        </div>
        {onboardingErrors.length > 0 && (
          <div className={`alert-inline warning ${styles.wizardWarning}`}>
            <div className={styles.wizardErrorTitle}>Points à traiter</div>
            <ul className={styles.wizardErrorList}>
              {onboardingErrors.map((item) => (
                <li key={item.code}>
                  {sanitizeUserFacingApiMessage(item.message, 400, "Une étape de préparation reste à terminer.")}
                  {item.hint
                    ? ` — ${sanitizeUserFacingApiMessage(item.hint, 400, "Consultez l'étape correspondante.")}`
                    : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        {showActivationCta && (
          <div className={`alert-inline ${styles.wizardCta}`}>
            <div>Besoin d'aide pour préparer l'activation Seqino ?</div>
            <a className="btn" href={CONTACT_URL}>
              Contacter l'assistance
            </a>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-header">
          <div>
            <h3 className="m-0">Ce qu'il faut preparer</h3>
            <p className="muted">Éléments à vérifier avant de démarrer l'e-invoicing.</p>
          </div>
          <span className="pill muted">Prerequis</span>
        </div>
        <div className="card">
          <ul>
            {prerequisites.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <div>
            <h3 className="m-0">Checklist readiness</h3>
            <p className="muted">Disponible = OK / À faire. Roadmap = non disponible pour le moment.</p>
          </div>
          <span className="pill muted">Statuts</span>
        </div>
        <div className="card grid-simple gap-12">
          {checks.map((check) => {
            const label = CHECK_LABELS[check.id] || check.id;
            const statusLabel = STATUS_LABELS[check.status] || check.status;
            const statusClass = STATUS_CLASS[check.status] || STATUS_CLASS.todo;
            const missing = formatMissingFields(check.missing_fields);
            const ctaLabel = check.status === "roadmap" ? "En savoir plus" : "Compléter";
            return (
              <div key={check.id} data-testid="readiness-check" className="row justify-between items-center gap-12">
                <div className="min-w-240">
                  <div className="font-700">{label}</div>
                  {missing && <div className="muted">Manquants: {missing}</div>}
                  {check.provider && <div className="muted">Provider: {check.provider}</div>}
                  {check.last_status && <div className="muted">Dernier statut: {check.last_status}</div>}
                </div>
                <div className="row gap-8">
                  <span className={statusClass}>{statusLabel}</span>
                  {check.action_url && check.status !== "ok" && (
                    <a className="btn secondary" href={check.action_url}>
                      {ctaLabel}
                    </a>
                  )}
                </div>
              </div>
            );
          })}
          {!checks.length && <div className="muted">Aucune vérification disponible.</div>}
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <div>
            <h3 className="m-0">Accès rapide</h3>
            <p className="muted">Pages utiles pour aller plus loin.</p>
          </div>
          <span className="pill muted">Raccourcis</span>
        </div>
        <div className="card grid-simple gap-12">
          {quickLinks.map((item) => (
            <div key={item.href} className="row justify-between items-center gap-12">
              <div className="grid-simple gap-4">
                <a className="btn secondary" href={item.href}>
                  {item.label}
                </a>
                <div className="muted small">{item.hint}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <OfficialSourcesCallout />
    </div>
  );
}

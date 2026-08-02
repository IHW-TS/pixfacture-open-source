"use client";

import { Link } from "@/figma/react-router-compat";
import { ArrowRight, CheckCircle2, Gauge, Link2, Rocket, Wrench } from "lucide-react";
import { Card, PrimaryLinkButton, SectionTitle, StatusPill } from "./AppPageHeader";

function toneFromPercent(percent: number) {
  if (percent >= 84) return { bar: "from-[#059669] to-[#10b981]", badge: "ok" as const, label: "Avancé" };
  if (percent >= 50) return { bar: "from-[#1d4ed8] to-[#4f46e5]", badge: "info" as const, label: "En progression" };
  return { bar: "from-[#d97706] to-[#f59e0b]", badge: "warn" as const, label: "À configurer" };
}

function statusLabel(summary: any) {
  if (summary?.commercial?.wide_ready) return { status: "ok" as const, label: "Prêt vente large" };
  if (summary?.commercial?.pilot_ready) return { status: "info" as const, label: "Prêt pilotes" };
  return { status: "warn" as const, label: "Préparation en cours" };
}

export function WorkspaceReadinessCard({
  summary,
  title = "Activation commerciale",
  description = "Suivi du niveau de préparation de l’espace pour vendre, onboarder et activer la réforme.",
  showActions = true,
  interactivePriorities = true,
  maxPriorities = 3,
}: {
  summary: any;
  title?: string;
  description?: string;
  showActions?: boolean;
  interactivePriorities?: boolean;
  maxPriorities?: number;
}) {
  if (!summary) return null;
  const percent = Number(summary?.setup?.percent || 0);
  const tone = toneFromPercent(percent);
  const badge = statusLabel(summary);
  const nextActions = Array.isArray(summary?.next_actions) ? summary.next_actions.slice(0, maxPriorities) : [];

  return (
    <Card className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <SectionTitle action={<StatusPill status={badge.status} label={badge.label} />}>{title}</SectionTitle>
          <p className="text-[#64748b] -mt-2" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
            {description}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.02fr,0.98fr] lg:items-start">
        <div className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] p-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div>
              <div
                className="text-[#0f172a]"
                style={{ fontSize: "1.5rem", fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1 }}
              >
                {percent}%
              </div>
              <p className="text-[#64748b] mt-1" style={{ fontSize: "0.75rem" }}>
                {summary?.setup?.completed || 0} étape(s) validée(s) sur {summary?.setup?.total || 0}
              </p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <Gauge className="h-5 w-5 text-[#1d4ed8]" />
            </div>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-white">
            <div className={`h-full bg-gradient-to-r ${tone.bar}`} style={{ width: `${percent}%` }} />
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-[#e2e8f0] bg-white p-3">
              <div
                className="flex items-center gap-2 text-[#64748b]"
                style={{ fontSize: "0.6875rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}
              >
                <Rocket className="h-3.5 w-3.5 text-[#1d4ed8]" /> Pilote
              </div>
              <div className="mt-2 text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                {summary?.commercial?.pilot_ready ? "Oui" : "Pas encore"}
              </div>
            </div>
            <div className="rounded-xl border border-[#e2e8f0] bg-white p-3">
              <div
                className="flex items-center gap-2 text-[#64748b]"
                style={{ fontSize: "0.6875rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}
              >
                <Link2 className="h-3.5 w-3.5 text-[#7c3aed]" /> Plateforme
              </div>
              <div className="mt-2 text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                {summary?.platforms?.connected_count || 0} connectée(s)
              </div>
            </div>
            <div className="rounded-xl border border-[#e2e8f0] bg-white p-3">
              <div
                className="flex items-center gap-2 text-[#64748b]"
                style={{ fontSize: "0.6875rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}
              >
                <CheckCircle2 className="h-3.5 w-3.5 text-[#059669]" /> Mandats
              </div>
              <div className="mt-2 text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                {summary?.platforms?.active_mandates || 0} actif(s)
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#e2e8f0] bg-white p-4">
          <div
            className="flex items-center gap-2 mb-3 text-[#0f172a]"
            style={{ fontSize: "0.875rem", fontWeight: 700 }}
          >
            <Wrench className="h-4 w-4 text-[#1d4ed8]" />
            Priorités du moment
          </div>
          {nextActions.length ? (
            <div className="space-y-2.5">
              {nextActions.map((action: any) => {
                const classes = interactivePriorities
                  ? "flex items-start gap-3 rounded-xl border border-[#e2e8f0] px-3.5 py-3 transition-all hover:border-[#1d4ed8]/25 hover:bg-[#f8fafc]"
                  : "flex items-start gap-3 rounded-xl border border-[#e2e8f0] bg-[#fafcff] px-3.5 py-3";
                const content = (
                  <>
                    <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-lg bg-[#eff6ff] text-[#1d4ed8]">
                      <ArrowRight className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                        {action.label}
                      </div>
                      {action.reason ? (
                        <div className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.5 }}>
                          {action.reason}
                        </div>
                      ) : null}
                    </div>
                  </>
                );

                if (!interactivePriorities) {
                  return (
                    <div key={action.key} className={classes}>
                      {content}
                    </div>
                  );
                }

                return (
                  <Link key={action.key} to={action.href} className={classes}>
                    {content}
                  </Link>
                );
              })}
            </div>
          ) : (
            <div
              className="rounded-xl border border-[#d1fae5] bg-[#ecfdf5] p-3.5 text-[#065f46]"
              style={{ fontSize: "0.8125rem", lineHeight: 1.5 }}
            >
              Votre espace est déjà bien avancé. Vous pouvez basculer sur une logique d’activation client, d’intégration
              et de relance.
            </div>
          )}
          {showActions && nextActions.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <PrimaryLinkButton to={nextActions[0].href}>Ouvrir l’étape suivante</PrimaryLinkButton>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function WorkspaceChecklist({
  summary,
  limit = 6,
  title = "Checklist de mise en route",
}: {
  summary: any;
  limit?: number;
  title?: string;
}) {
  if (!summary) return null;
  const steps = Array.isArray(summary?.setup?.steps) ? summary.setup.steps.slice(0, limit) : [];
  return (
    <Card className="space-y-4">
      <SectionTitle>{title}</SectionTitle>
      <div className="space-y-2.5">
        {steps.map((step: any, index: number) => (
          <div
            key={step.key || index}
            className="flex items-start gap-3 rounded-xl border border-[#e2e8f0] bg-white px-3.5 py-3"
          >
            <div
              className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full ${step.done ? "bg-[#059669] text-white" : "bg-[#eff6ff] text-[#1d4ed8]"}`}
            >
              {step.done ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <span style={{ fontSize: "0.75rem", fontWeight: 700 }}>{index + 1}</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="text-[#0f172a]" style={{ fontSize: "0.8125rem", fontWeight: 700 }}>
                  {step.label}
                </div>
                <StatusPill status={step.done ? "ok" : "warn"} label={step.done ? "OK" : "À faire"} />
              </div>
              {step.reason ? (
                <div className="mt-1 text-[#64748b]" style={{ fontSize: "0.75rem", lineHeight: 1.5 }}>
                  {step.reason}
                </div>
              ) : null}
              {!step.done && step.href ? (
                <Link
                  to={step.href}
                  className="mt-2 inline-flex items-center gap-1 text-[#1d4ed8] hover:text-[#1e40af]"
                  style={{ fontSize: "0.75rem", fontWeight: 700 }}
                >
                  Ouvrir <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

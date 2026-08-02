"use client";

import { useEffect, useMemo, useState } from "react";
import { complianceTimeline, formatYearRange } from "@/lib/complianceTimeline";
import { fetchComplianceClaims } from "@/lib/complianceClaims";

type ComplianceClaimLevel = "export_only" | "compatible" | "partnered";

type ComplianceRuntimeStatus = {
  allowed_claims?: ComplianceClaimLevel[];
  pdp_integration_enabled?: boolean;
  seqino_enabled?: boolean;
  chorus_enabled?: boolean;
  mandate_required?: boolean;
  ubl_export_enabled?: boolean;
  facturx_pdfa_mode?: string | null;
};

type ComplianceStatusRow = {
  label: string;
  status: "fait" | "en_cours" | "non";
  note?: string;
};

const PRODUCTION_FALLBACK: ComplianceRuntimeStatus = { allowed_claims: ["export_only"] };
const TIMELINE_RANGE = formatYearRange(
  complianceTimeline.einvoicing.reception,
  complianceTimeline.einvoicing.emission_pme_micro,
  "-",
);

const buildPartnerRow = (status: ComplianceRuntimeStatus | null): ComplianceStatusRow => {
  const allowed = new Set(status?.allowed_claims || []);
  if (allowed.has("partnered")) {
    let note = "Connecté via partenaire";
    if (status?.mandate_required) {
      note += " — mandat requis";
    }
    return {
      label: "Connexion plateforme agréée (PA, ex-PDP) partenaire B2B",
      status: "fait",
      note,
    };
  }
  if (allowed.has("compatible")) {
    return {
      label: "Connexion plateforme agréée (PA, ex-PDP) partenaire B2B",
      status: "en_cours",
      note: "Connectable via plateforme agréée selon contrat, mandat et configuration",
    };
  }
  return {
    label: "Connexion plateforme agréée (PA, ex-PDP) partenaire B2B",
    status: "en_cours",
    note: "Mode export : connexion plateforme agréée à activer",
  };
};

export default function ComplianceStatusTable() {
  const [runtimeStatus, setRuntimeStatus] = useState<ComplianceRuntimeStatus | null>(
    process.env.NODE_ENV === "production" ? PRODUCTION_FALLBACK : null,
  );
  useEffect(() => {
    let active = true;
    fetchComplianceClaims().then((data) => {
      if (!active || !data) return;
      setRuntimeStatus(data);
    });
    return () => {
      active = false;
    };
  }, []);

  const rows = useMemo(() => {
    const pdfaMode = (runtimeStatus?.facturx_pdfa_mode || "").trim().toLowerCase();
    const facturxNote = pdfaMode === "strict" ? "PDF/A-3b strict" : "PDF/A-3b selon validation configurée";
    const ublEnabled = Boolean(runtimeStatus?.ubl_export_enabled);
    const chorusEnabled = Boolean(runtimeStatus?.chorus_enabled);
    const items: ComplianceStatusRow[] = [
      { label: "Factur-X / CII", status: "fait", note: facturxNote },
      {
        label: "UBL",
        status: ublEnabled ? "fait" : "en_cours",
        note: ublEnabled ? "Export actif pour votre espace" : "À activer pour votre espace",
      },
      {
        label: "Canal public (B2G) : Dépôt Factur-X",
        status: chorusEnabled ? "fait" : "en_cours",
        note: chorusEnabled ? "Actif si PISTE configuré" : "À activer/configurer avant transmission B2G",
      },
      buildPartnerRow(runtimeStatus),
      { label: `Réforme B2B ${TIMELINE_RANGE || "2026-2027"} : annuaire/interop`, status: "en_cours", note: "Roadmap" },
      {
        label: "Export e-reporting",
        status: "fait",
        note: "Disponible en Pro selon périmètre",
      },
      {
        label: "Transmission PA e-reporting",
        status: "en_cours",
        note: "Selon activation PA, mandat et configuration",
      },
    ];
    return items;
  }, [runtimeStatus]);

  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th>Couverture</th>
            <th>Fait</th>
            <th>En cours</th>
            <th>Non</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{row.status === "fait" ? "X" : ""}</td>
              <td>{row.status === "en_cours" ? "X" : ""}</td>
              <td>{row.status === "non" ? "X" : ""}</td>
              <td>{row.note || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

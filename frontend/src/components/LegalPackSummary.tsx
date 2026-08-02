"use client";

import { useMemo } from "react";
import { getLegalConfig, getLegalDocVersion } from "@/lib/legalConfig";
import { LEGAL_VARIABLES } from "@/app/legal/variables";
import { SUBPROCESSORS, SUBPROCESSORS_LAST_UPDATED, formatSubprocessorDate } from "@/lib/subprocessors";
import { PLATFORM_LABEL_LONG } from "@/lib/terminology";

const buildDocLink = (label: string, url?: string) => {
  if (!url) return <span className="muted">—</span>;
  return (
    <a
      href={url}
      target={url.startsWith("http") ? "_blank" : undefined}
      rel={url.startsWith("http") ? "noreferrer" : undefined}
    >
      {label}
    </a>
  );
};

const buildLegalPackMarkdown = () => {
  const legal = getLegalConfig();
  const pdfLinks = LEGAL_VARIABLES.pdfLinks;
  const providers = LEGAL_VARIABLES.providers;
  const support = LEGAL_VARIABLES.support;
  const hosting = LEGAL_VARIABLES.hosting;
  const rgpd = LEGAL_VARIABLES.rgpdContact;

  const docLinks = {
    cgu: pdfLinks.cgu || "/legal/terms",
    cgv: pdfLinks.cgv || "/legal/cgv",
    dpa: pdfLinks.dpa || "/legal/dpa",
    privacy: "/legal/privacy",
    cookies: "/legal/cookies",
  };

  const lines = [
    "# Dossier légal",
    "",
    `Dernière mise à jour : ${legal.legalLastUpdatedISO || "—"}`,
    "",
    "## Identité",
    `- Raison sociale : ${legal.companyName || "—"}`,
    `- Forme juridique : ${legal.legalForm || "—"}`,
    `- Capital social : ${legal.capital || "—"}`,
    `- RCS : ${legal.rcsNumber || "—"}${legal.rcsCity ? ` (${legal.rcsCity})` : ""}`,
    `- TVA : ${legal.vatNumber || "—"}`,
    `- Adresse : ${legal.address || "—"}`,
    `- Email : ${legal.email || "—"}`,
    `- Directeur de publication : ${legal.publisherDirector || "—"}`,
    "",
    "## Contacts",
    `- Support : ${legal.supportEmail || "—"}`,
    `- RGPD (${rgpd.label}) : ${rgpd.email || "—"}`,
    "",
    "## Hébergement",
    `- Hébergeur : ${hosting.provider || "—"}`,
    `- Adresse : ${hosting.location || "—"}`,
    "",
    "## Prestataires",
    `- Email : ${providers.email || "—"}`,
    `- Paiement : ${providers.payment || "—"}`,
    `- Monitoring : ${providers.monitoring || "—"}`,
    `- ${PLATFORM_LABEL_LONG} : ${providers.pdp || "—"}`,
    "",
    "## Support & SLA",
    `- Horaires : ${support.hours || "—"} (${support.timezone || "—"})`,
    `- Critique : ${support.responseTargets?.critical || "—"}`,
    `- Majeur : ${support.responseTargets?.major || "—"}`,
    `- Mineur : ${support.responseTargets?.minor || "—"}`,
    "",
    "## Documents",
    `- CGU : ${docLinks.cgu} (version ${getLegalDocVersion("terms") || "—"})`,
    `- CGV : ${docLinks.cgv} (version ${getLegalDocVersion("cgv") || "—"})`,
    `- DPA : ${docLinks.dpa} (version ${getLegalDocVersion("dpa") || "—"})`,
    `- Privacy : ${docLinks.privacy} (version ${getLegalDocVersion("privacy") || "—"})`,
    `- Cookies : ${docLinks.cookies} (version ${getLegalDocVersion("cookies") || "—"})`,
    "",
    "## Sous-traitants",
  ];

  if (!SUBPROCESSORS.length) {
    lines.push("- Aucun sous-traitant déclaré.");
    return lines.join("\n");
  }

  lines.push("| Nom | Finalité | Localisation | Optionnel |");
  lines.push("| --- | --- | --- | --- |");
  SUBPROCESSORS.forEach((item) => {
    lines.push(`| ${item.name} | ${item.purpose} | ${item.location || "—"} | ${item.notes || "—"} |`);
  });

  return lines.join("\n");
};

export default function LegalPackSummary() {
  const legal = getLegalConfig();
  const pdfLinks = LEGAL_VARIABLES.pdfLinks;
  const providers = LEGAL_VARIABLES.providers;
  const support = LEGAL_VARIABLES.support;
  const hosting = LEGAL_VARIABLES.hosting;
  const rgpd = LEGAL_VARIABLES.rgpdContact;
  const docVersions = {
    terms: getLegalDocVersion("terms"),
    cgv: getLegalDocVersion("cgv"),
    dpa: getLegalDocVersion("dpa"),
    privacy: getLegalDocVersion("privacy"),
    cookies: getLegalDocVersion("cookies"),
  };

  const docLinks = {
    cgu: pdfLinks.cgu || "/legal/terms",
    cgv: pdfLinks.cgv || "/legal/cgv",
    dpa: pdfLinks.dpa || "/legal/dpa",
    privacy: "/legal/privacy",
    cookies: "/legal/cookies",
  };

  const markdown = useMemo(() => buildLegalPackMarkdown(), []);

  const handleCopy = async () => {
    if (!navigator?.clipboard?.writeText) return;
    await navigator.clipboard.writeText(markdown);
  };

  const handleDownload = () => {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `legal-pack-${legal.legalLastUpdatedISO || "latest"}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid-simple gap-16">
      <div className="card grid-simple gap-8">
        <div className="group-title">Variables légales actives</div>
        <div className="grid-3">
          <div>
            <div className="muted small">Raison sociale</div>
            <div>{legal.companyName || "—"}</div>
          </div>
          <div>
            <div className="muted small">Forme juridique</div>
            <div>{legal.legalForm || "—"}</div>
          </div>
          <div>
            <div className="muted small">Capital social</div>
            <div>{legal.capital || "—"}</div>
          </div>
          <div>
            <div className="muted small">RCS</div>
            <div>
              {legal.rcsNumber || "—"}
              {legal.rcsCity ? ` (${legal.rcsCity})` : ""}
            </div>
          </div>
          <div>
            <div className="muted small">TVA</div>
            <div>{legal.vatNumber || "—"}</div>
          </div>
          <div>
            <div className="muted small">Adresse</div>
            <div>{legal.address || "—"}</div>
          </div>
          <div>
            <div className="muted small">Email société</div>
            <div>{legal.email || "—"}</div>
          </div>
          <div>
            <div className="muted small">Support</div>
            <div>{legal.supportEmail || "—"}</div>
          </div>
          <div>
            <div className="muted small">RGPD</div>
            <div>{rgpd.email || "—"}</div>
          </div>
        </div>
      </div>

      <div className="card grid-simple gap-8">
        <div className="group-title">Documents légaux</div>
        <table className="table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Version</th>
              <th>Lien</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>CGU</td>
              <td>{docVersions.terms || "—"}</td>
              <td>{buildDocLink("Ouvrir les CGU", docLinks.cgu)}</td>
            </tr>
            <tr>
              <td>CGV</td>
              <td>{docVersions.cgv || "—"}</td>
              <td>{buildDocLink("Ouvrir les CGV", docLinks.cgv)}</td>
            </tr>
            <tr>
              <td>DPA</td>
              <td>{docVersions.dpa || "—"}</td>
              <td>{buildDocLink("Ouvrir le DPA", docLinks.dpa)}</td>
            </tr>
            <tr>
              <td>Confidentialité</td>
              <td>{docVersions.privacy || "—"}</td>
              <td>{buildDocLink("Ouvrir la politique de confidentialité", docLinks.privacy)}</td>
            </tr>
            <tr>
              <td>Cookies</td>
              <td>{docVersions.cookies || "—"}</td>
              <td>{buildDocLink("Ouvrir la politique cookies", docLinks.cookies)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card grid-simple gap-8">
        <div className="group-title">Hébergement & prestataires</div>
        <div className="grid-3">
          <div>
            <div className="muted small">Hébergeur</div>
            <div>{hosting.provider || "—"}</div>
          </div>
          <div>
            <div className="muted small">Adresse hébergeur</div>
            <div>{hosting.location || "—"}</div>
          </div>
          <div>
            <div className="muted small">Support</div>
            <div>
              {support.hours || "—"} ({support.timezone || "—"})
            </div>
          </div>
          <div>
            <div className="muted small">Service d'envoi email</div>
            <div>{providers.email || "—"}</div>
          </div>
          <div>
            <div className="muted small">Paiement</div>
            <div>{providers.payment || "—"}</div>
          </div>
          <div>
            <div className="muted small">Monitoring</div>
            <div>{providers.monitoring || "—"}</div>
          </div>
          <div>
            <div className="muted small">{PLATFORM_LABEL_LONG}</div>
            <div>{providers.pdp || "—"}</div>
          </div>
        </div>
      </div>

      <div className="card grid-simple gap-8">
        <div className="row justify-between gap-8 flex-wrap">
          <div>
            <div className="group-title">Sous-traitants</div>
            <div className="muted small">
              Dernière mise à jour : {formatSubprocessorDate(SUBPROCESSORS_LAST_UPDATED) || "—"}
            </div>
          </div>
          <a className="btn secondary" href="/legal/dpa" target="_blank" rel="noreferrer">
            Ouvrir l’annexe DPA
          </a>
        </div>
        {SUBPROCESSORS.length === 0 ? (
          <p className="muted">Aucun sous-traitant déclaré.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Finalité</th>
                <th>Localisation</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {SUBPROCESSORS.map((item) => (
                <tr key={item.name}>
                  <td>{item.name}</td>
                  <td>{item.purpose}</td>
                  <td>{item.location || "—"}</td>
                  <td>{item.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card grid-simple gap-12">
        <div className="group-title">Export pack légal</div>
        <div className="row gap-8 flex-wrap">
          <button className="btn" type="button" onClick={handleDownload}>
            Télécharger en Markdown
          </button>
          <button className="btn secondary" type="button" onClick={handleCopy}>
            Copier le Markdown
          </button>
        </div>
        <textarea className="input min-h-220" readOnly value={markdown} />
      </div>
    </div>
  );
}

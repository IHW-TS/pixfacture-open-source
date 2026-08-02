import { CheckCircle2, XCircle, ExternalLink } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import { LegalPageShell, LegalSection, LegalSubSection, LegalCallout } from "../components/landing/LegalPageShell";

const sections = [
  { title: "Résumé & périmètre", anchor: "resume" },
  { title: "Définitions", anchor: "definitions" },
  { title: "Objet et périmètre", anchor: "objet" },
  { title: "Accès, comptes & rôles", anchor: "acces" },
  { title: "E‑facturation (clause critique)", anchor: "efacturation" },
  { title: "Fonctionnalités", anchor: "fonctionnalites" },
  { title: "Conditions financières", anchor: "financier" },
  { title: "Durée & résiliation", anchor: "resiliation" },
  { title: "Support & maintenance", anchor: "support" },
  { title: "Réversibilité & export", anchor: "reversibilite" },
  { title: "Responsabilité", anchor: "responsabilite" },
  { title: "Propriété intellectuelle", anchor: "pi" },
  { title: "Données personnelles", anchor: "donnees" },
  { title: "Droit applicable", anchor: "droit" },
];

const definitions = [
  { term: "Service", def: "Solution SaaS de facturation, d'exports et de suivi." },
  { term: "Client", def: "Entité professionnelle (B2B) souscrivant au Service." },
  { term: "Utilisateur", def: "Personne autorisée par le Client (owner, admin, comptable, lecteur)." },
  { term: "Données Client", def: "Informations et documents saisis/importés (factures, PDF, XML, journaux)." },
  { term: "Données Personnelles", def: "Données à caractère personnel traitées via le Service." },
  { term: "Facture", def: "Document de facturation émis par le Client via le Service." },
  { term: "Factur‑X", def: "Format hybride PDF + XML conforme aux spécifications DGFiP." },
  {
    term: "Plateforme Agréée (PA)",
    def: "Tiers immatriculé par l'État pour les flux réglementaires (e‑invoicing, e‑reporting).",
  },
  {
    term: "Solution Compatible",
    def: "Logiciel pouvant être connecté à une PA selon le plan, le mandat, le contrat et la configuration technique applicables.",
  },
];

export function TermsPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Document contractuel"
        title="CGV/CGU — Conditions Générales d'Utilisation et de Vente"
        subtitle="Les présentes conditions encadrent l'accès et l'usage du Service, ses fonctionnalités, ainsi que les obligations de l'Éditeur et du Client."
        version="À compléter"
        lastUpdated="À compléter"
        sections={sections}
      >
        <LegalSection id="resume" title="Résumé des conditions">
          <LegalCallout type="important">
            Ce document ne constitue pas un conseil juridique, comptable ou fiscal. La conformité dépend de votre
            situation (TVA, opérations, secteurs) et des textes applicables. Les spécifications techniques évoluent (se
            référer à impots.gouv.fr).
          </LegalCallout>

          <div className="grid sm:grid-cols-2 gap-4 mt-4">
            <div className="border border-emerald-200 rounded-xl p-4 bg-emerald-50">
              <p className="text-[12px] uppercase tracking-widest text-emerald-700 mb-3">Ce que nous faisons</p>
              <ul className="space-y-1.5">
                {[
                  "Logiciel de facturation B2B + exports Factur‑X / UBL / CII",
                  "Exports PDF/XML/CSV + journaux",
                  "Connecteurs vers plateformes agréées selon activation, contrat, mandat et statut applicable",
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-emerald-800">
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border border-rose-200 rounded-xl p-4 bg-rose-50">
              <p className="text-[12px] uppercase tracking-widest text-rose-700 mb-3">Ce que nous ne faisons pas</p>
              <ul className="space-y-1.5">
                {[
                  "Nous ne sommes pas une PA immatriculée par l'État",
                  "Nous ne gérons pas l'immatriculation de plateforme agréée",
                  "Pas de promesse de certification/immatriculation PA",
                  "La transmission réglementaire passe par la PA choisie par le Client",
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-rose-800">
                    <XCircle size={14} className="mt-0.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 flex gap-3">
            <a
              href="#"
              className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
            >
              Ouvrir CGU (PDF) <ExternalLink size={11} />
            </a>
            <a
              href="#"
              className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
            >
              Ouvrir CGV (PDF) <ExternalLink size={11} />
            </a>
          </div>
        </LegalSection>

        <LegalSection id="definitions" title="Définitions">
          <div className="space-y-3">
            {definitions.map((d, i) => (
              <div key={i} className="flex gap-3 text-[14px]">
                <span className="font-semibold text-slate-800 shrink-0 w-40">{d.term}</span>
                <span className="text-slate-600">{d.def}</span>
              </div>
            ))}
          </div>
        </LegalSection>

        <LegalSection id="objet" title="Objet et périmètre">
          <p>
            Le Service est destiné aux <strong>professionnels (B2B)</strong> souhaitant émettre et gérer des factures
            électroniques en conformité avec le cadre français et européen.
          </p>
          <ul className="space-y-2 pl-2 mt-3">
            <li>
              <strong>Objet</strong> : logiciel SaaS de facturation B2B, exports Factur‑X/CII/UBL selon configuration.
            </li>
            <li>
              <strong>E‑invoicing</strong> : le Service n'est pas une PA ; la transmission réglementaire passe via une
              plateforme agréée (PA) choisie par le Client, ou via un connecteur partenaire activé par l'Éditeur (mode
              sponsor, sans identifiant technique côté client).
            </li>
            <li>
              <strong>Archivage</strong> : export possible ; archivage probant (immutabilité Object Lock si activé)
              selon configuration. La conformité complète dépend de votre configuration (rétention, sauvegardes,
              procédures) et des exigences applicables.
            </li>
          </ul>
        </LegalSection>

        <LegalSection id="acces" title="Accès au Service, compte, rôles et sécurité">
          <p>
            Le Client crée et gère ses comptes utilisateurs. Les rôles conditionnent les permissions (administration,
            comptabilité, lecture).
          </p>
          <ul className="space-y-1.5 pl-2 mt-2">
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Le Client demeure responsable de la sécurité des accès, des mots de passe, et de l'activation de la double
              authentification si disponible.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Toute action réalisée via un compte autorisé est réputée réalisée par le Client.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Le Client doit notifier immédiatement l'Éditeur en cas de compromission de compte.
            </li>
          </ul>
        </LegalSection>

        <LegalSection id="efacturation" title="E‑facturation (clause critique)">
          <LegalCallout type="warning">
            Nous ne sommes pas une plateforme agréée (PA). Le Service est un logiciel de facturation et ne constitue pas
            une PA immatriculée par l'État.
          </LegalCallout>
          <div className="mt-4 space-y-3">
            <p>
              La transmission réglementaire (e‑invoicing/e‑reporting) s'effectue via une{" "}
              <strong>Plateforme Agréée</strong> choisie et contractualisée par le Client.
            </p>
            <p>
              L'Éditeur peut fournir un connecteur vers une PA activé en mode sponsor (sans identifiant technique côté
              client) et accompagner la mise en place du mandat lorsque requis.
            </p>
            <p>
              La souscription au plan Pro donne accès aux fonctionnalités et à la préparation du connecteur partenaire.
              Elle ne vaut pas acceptation automatique d'un mandat PA. La création ou le suivi d'un mandat nécessite une
              action séparée et explicite dans l'espace e-facturation. Le Client reste responsable de l'exactitude de
              ses informations d'entreprise.
            </p>
            <p>
              Sans connecteur disponible ou validé, le Service reste utilisable en <strong>mode export only</strong> :
              le Client transmet via sa PA ou le canal de son choix.
            </p>
            <div className="flex flex-col gap-1.5 mt-3">
              <p className="text-[12px] text-slate-400">Références officielles :</p>
              <a
                href="https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
              >
                Liste des plateformes agréées <ExternalLink size={11} />
              </a>
              <a
                href="https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
              >
                Facturation électronique et plateformes agréées <ExternalLink size={11} />
              </a>
            </div>
          </div>
        </LegalSection>

        <LegalSection id="fonctionnalites" title="Fonctionnalités">
          <p>
            Le Service permet la création, l'édition et l'export de factures (PDF, Factur‑X, CII/UBL selon activation),
            ainsi que la consultation de journaux et rapports.
          </p>
          <p>
            Des fonctionnalités de réception, statuts et e‑reporting peuvent être proposées selon la configuration et
            l'activation d'un connecteur PA.
          </p>
          <LegalSubSection title="Fonctionnalités beta / feature flags">
            <p>
              Certaines fonctionnalités peuvent être en version beta ou activées par des feature flags. Ces
              fonctionnalités peuvent évoluer, être limitées ou retirées. Leur usage reste optionnel et sans promesse de
              disponibilité permanente.
            </p>
          </LegalSubSection>
        </LegalSection>

        <LegalSection id="financier" title="Conditions financières">
          <LegalSubSection title="Offre & prix">
            <p>
              Plans <strong>Starter / Pro / Volume</strong>, facturation mensuelle ou annuelle selon la grille tarifaire
              en vigueur. Les prix sont <strong>HT</strong>, taxes applicables en sus.
            </p>
          </LegalSubSection>
          <LegalSubSection title="Facturation annuelle">
            <p>
              Lorsque le Client choisit une facturation annuelle, l'abonnement est payable d'avance pour 12 mois. Sauf
              résiliation avant l'échéance, l'abonnement se renouvelle automatiquement à la date anniversaire aux
              conditions tarifaires en vigueur.
            </p>
          </LegalSubSection>
          <LegalSubSection title="Jetons de transmission">
            <p>
              Les transmissions connectées peuvent consommer des jetons selon l'usage et les packs activés. Il n'existe
              pas de recharge mensuelle automatique : les packs sont achetés ponctuellement.{" "}
              <strong>Aucune facturation variable automatique n'est appliquée sans accord exprès du Client.</strong>
            </p>
          </LegalSubSection>
          <LegalSubSection title="Retards de paiement">
            <p>
              En cas de retard de paiement, des pénalités légales peuvent s'appliquer (indemnité forfaitaire de
              recouvrement et taux légal) conformément au Code de commerce. En cas de défaut persistant, l'accès peut
              être suspendu après notification.
            </p>
          </LegalSubSection>
        </LegalSection>

        <LegalSection id="resiliation" title="Durée, renouvellement et résiliation">
          <p>
            Le contrat prend effet à la souscription et se renouvelle tacitement par période identique. Le Client peut
            résilier avant la prochaine échéance depuis l'espace client.
          </p>
          <p>
            Les sommes dues restent exigibles pour la période en cours. En cas d'impayé ou de violation grave, l'Éditeur
            peut suspendre ou résilier l'accès.
          </p>
        </LegalSection>

        <LegalSection id="support" title="Support & maintenance">
          <p>
            Support par email (délais de traitement selon plan souscrit — aucun délai garanti en l'absence d'accord
            contractuel spécifique). Des maintenances planifiées peuvent être annoncées ; les correctifs urgents peuvent
            entraîner des interruptions limitées.
          </p>
          <p>
            <strong>Disponibilité</strong> : le Service est fourni en <strong>obligation de moyens</strong>, sans
            engagement de disponibilité ferme en l'absence de SLA spécifique. SLA éventuel selon contrat (offre Volume).
          </p>
        </LegalSection>

        <LegalSection id="reversibilite" title="Réversibilité & export des données">
          <p>
            Le Client peut exporter ses données (PDF, Factur‑X, CSV, journaux) pendant la durée du contrat. Après
            résiliation, une restitution supplémentaire peut être fournie sur demande dans un délai raisonnable (ex. 30
            jours).
          </p>
          <p>
            La conservation des données s'effectue selon les obligations légales applicables et les paramètres
            contractuels.
          </p>
        </LegalSection>

        <LegalSection id="responsabilite" title="Responsabilité & limitation">
          <p>
            Le Client demeure responsable de la qualité des données saisies, de ses paramètres (TVA, mentions, routage)
            et du choix de la plateforme agréée (PA) immatriculée par l'État.
          </p>
          <p>
            L'Éditeur ne peut être tenu responsable des indisponibilités, retards, rejets ou erreurs imputables à la PA
            tierce, au PPF ou à tout prestataire externe utilisé par le Client.
          </p>
          <p>
            Sauf dispositions d'ordre public, la responsabilité de l'Éditeur est{" "}
            <strong>limitée aux montants payés par le Client au cours des 12 derniers mois</strong>.
          </p>
        </LegalSection>

        <LegalSection id="pi" title="Propriété intellectuelle">
          <p>
            Le Service et sa documentation restent la propriété de l'Éditeur. Une licence d'utilisation{" "}
            <strong>non exclusive</strong> est accordée pendant la durée du contrat.
          </p>
          <p>
            Il est interdit de copier, modifier, rétro-concevoir ou exploiter le Service hors du cadre contractuel.
            Chaque partie s'engage à conserver confidentielles les informations non publiques reçues de l'autre partie.
          </p>
        </LegalSection>

        <LegalSection id="donnees" title="Données personnelles">
          <p>
            Le traitement des données personnelles est encadré par l'
            <a href="/legal/dpa" className="text-blue-700 underline underline-offset-2">
              accord de traitement des données (DPA)
            </a>{" "}
            et la{" "}
            <a href="/legal/privacy" className="text-blue-700 underline underline-offset-2">
              politique de confidentialité
            </a>
            .
          </p>
        </LegalSection>

        <LegalSection id="droit" title="Droit applicable et juridiction">
          <p>
            <strong>Droit applicable</strong> : droit français. <strong>Juridiction compétente</strong> : à compléter
            selon les informations légales de l'Éditeur.
          </p>
          <LegalCallout type="info">
            Les informations légales complètes (raison sociale, RCS, TVA, adresse, tribunal compétent) sont à compléter
            dans les paramètres légaux du service.
          </LegalCallout>
        </LegalSection>

        <div className="mt-10 pt-6 border-t border-slate-100 flex flex-wrap gap-4">
          <a
            href="/legal/dpa"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            DPA <ExternalLink size={11} />
          </a>
          <a
            href="/legal/privacy"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            Confidentialité <ExternalLink size={11} />
          </a>
          <a
            href="/security"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            Sécurité <ExternalLink size={11} />
          </a>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}

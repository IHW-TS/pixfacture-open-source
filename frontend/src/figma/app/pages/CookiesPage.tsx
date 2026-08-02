"use client";
import { LegalLayout } from "../components/landing/LegalLayout";
import {
  LegalPageShell,
  LegalSection,
  LegalSubSection,
  LegalCallout,
  LegalTable,
} from "../components/landing/LegalPageShell";
import { FALLBACK_LEGAL_VARIABLES, type LegalPageProps } from "./legalVariablesFallback";

const sections = [
  { title: "Qu'est-ce qu'un cookie ?", anchor: "definition" },
  { title: "Cookies strictement nécessaires", anchor: "necessaires" },
  { title: "Cookies de mesure d'audience", anchor: "audience" },
  { title: "Cookies marketing", anchor: "marketing" },
  { title: "Durée de conservation", anchor: "duree" },
  { title: "Gestion du consentement", anchor: "consentement" },
];

const formatLegalDate = (value: string) => {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
};

export function CookiesPage({ legalVariables = FALLBACK_LEGAL_VARIABLES }: LegalPageProps) {
  const legal = legalVariables;
  const company = legal.company;

  return (
    <LegalLayout>
      <LegalPageShell
        badge="Légal"
        title="Politique cookies"
        subtitle="Cette page décrit les cookies utilisés sur le site et l'application, leur finalité et le statut actuel des fonctionnalités optionnelles."
        version={legal.docVersions.cookies}
        lastUpdated={formatLegalDate(company.legalLastUpdatedISO)}
        sections={sections}
      >
        <LegalSection id="definition" title="Qu'est-ce qu'un cookie ?">
          <p>
            Un cookie est un petit fichier texte déposé sur votre terminal (ordinateur, tablette, smartphone) lors de la
            consultation d'un service en ligne. Il permet d'assurer le fonctionnement et la sécurité du service et, le
            cas échéant, de mesurer l'audience ou proposer des contenus marketing.
          </p>
          <p>
            L'éditeur s'engage à mettre à jour cette page en cas de changement majeur dans l'utilisation des cookies.
          </p>
        </LegalSection>

        <LegalSection id="necessaires" title="Cookies strictement nécessaires">
          <p>
            Ces cookies sont indispensables au fonctionnement du service. Ils ne peuvent pas être désactivés sans
            affecter l'utilisation du site.
          </p>
          <LegalTable
            headers={["Cookie", "Finalité", "Durée"]}
            rows={[
              ["access_token", "Jeton d'accès à l'API (HttpOnly — non accessible depuis JS)", "1 heure maximum"],
              ["refresh_token", "Renouvellement automatique de la session (HttpOnly)", "30 jours maximum"],
              ["csrf_token", "Protection anti-falsification des requêtes", "30 jours maximum"],
              ["auth_session", "Indicateur de session utilisé par l'interface", "30 jours maximum"],
              ["sidebar_state", "Mémorisation de l’état ouvert ou replié du menu latéral", "7 jours maximum"],
            ]}
          />
          <LegalCallout type="info">
            Les cookies d'authentification sensibles sont définis avec le flag <strong>HttpOnly</strong>. Le cookie de
            sécurité et l'indicateur de session restent lisibles par le navigateur afin de protéger les requêtes et
            piloter l'interface.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="audience" title="Cookies de mesure d'audience">
          <LegalSubSection title="Statut">
            <p>
              <strong>Désactivée sur cette instance.</strong> Aucun service de mesure d'audience n'est chargé et aucun
              cookie de mesure d'audience n'est déposé.
            </p>
          </LegalSubSection>
          <p>
            Toute activation future devra être documentée ici avant sa mise en service, avec le nom du fournisseur, la
            technologie réellement utilisée et sa durée de conservation.
          </p>
        </LegalSection>

        <LegalSection id="marketing" title="Cookies marketing">
          <p>
            <strong>Désactivés sur cette instance.</strong> Aucun cookie de remarketing, de retargeting ou de publicité
            personnalisée n'est déposé.
          </p>
          <LegalCallout type="info">
            Toute activation future devra être décrite dans cette politique et soumise au consentement préalable
            lorsqu'il est requis.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="duree" title="Durée de conservation">
          <LegalTable
            headers={["Type", "Durée maximale"]}
            rows={[
              ["access_token", "1 heure maximum"],
              ["refresh_token, csrf_token et auth_session", "30 jours maximum"],
              ["sidebar_state", "7 jours maximum"],
            ]}
          />
        </LegalSection>

        <LegalSection id="consentement" title="Gestion du consentement">
          <p>
            Aucun cookie optionnel d'audience ou de marketing n'étant actuellement activé, aucun bandeau de consentement
            ni centre de préférences n'est proposé. Il n'existe donc aucun choix de cookies optionnels à modifier sur
            cette instance.
          </p>
          <p>
            Avant toute activation future nécessitant un consentement, cette politique sera mise à jour et une interface
            permettant d'accepter, de refuser puis de retirer ce consentement sera mise à disposition.
          </p>
          <p>
            Pour les cookies strictement nécessaires, aucun consentement n'est requis car ils sont indispensables au
            fonctionnement du service.
          </p>
          <p className="mt-3">
            Pour toute question sur la gestion de vos données, consultez notre{" "}
            <a href="/legal/privacy" className="text-blue-700 underline underline-offset-2">
              Politique de confidentialité
            </a>{" "}
            ou écrivez à {legal.rgpdContact.email}.
          </p>
        </LegalSection>
      </LegalPageShell>
    </LegalLayout>
  );
}

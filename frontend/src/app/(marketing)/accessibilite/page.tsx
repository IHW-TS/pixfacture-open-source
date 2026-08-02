import { LegalLayout } from "@/figma/app/components/landing/LegalLayout";
import { LegalCallout, LegalPageShell, LegalSection } from "@/figma/app/components/landing/LegalPageShell";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Accessibilité",
  description: "État d'accessibilité et moyens de contact de PixFacture.",
  path: "/accessibilite",
});

export default function AccessibilityPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Accessibilité"
        title="Déclaration d’accessibilité"
        subtitle="Les mainteneurs travaillent à rendre PixFacture accessible au plus grand nombre."
        version="1.0"
        lastUpdated="14 juillet 2026"
        sections={[
          { title: "État de conformité", anchor: "etat" },
          { title: "Évaluation", anchor: "evaluation" },
          { title: "Retour et contact", anchor: "contact" },
          { title: "Voies de recours", anchor: "recours" },
        ]}
      >
        <LegalSection id="etat" title="État de conformité">
          <LegalCallout type="warning">
            PixFacture est déclaré non conforme au RGAA 4.1.2, car l’audit manuel exhaustif des 106 critères n’est pas
            encore achevé. Aucun pourcentage de conformité ni aucune certification ne sont revendiqués à ce stade.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="evaluation" title="Évaluation en cours">
          <p>
            Une auto-évaluation technique a couvert les pages publiques et les principaux parcours applicatifs. Les
            contrôles automatisables, le clavier, les contrastes et le réaffichage mobile font l’objet de tests de
            non-régression. Les vérifications humaines avec technologies d’assistance restent à terminer avant le calcul
            d’un taux de conformité.
          </p>
          <p>
            Technologies prévues : NVDA avec Firefox, VoiceOver avec Safari, TalkBack avec Chrome, navigation au
            clavier, zoom à 200 % et réaffichage à 320 pixels CSS.
          </p>
        </LegalSection>

        <LegalSection id="contact" title="Retour d’information et contact">
          <p>
            Si vous ne pouvez pas accéder à un contenu ou à une fonctionnalité, écrivez à{" "}
            <a className="text-blue-700 underline underline-offset-2" href="mailto:contact@example.test">
              contact@example.test
            </a>
            . Indiquez la page, l’action tentée, votre navigateur et, si possible, la technologie d’assistance utilisée.
            Nous vous proposerons une information ou une solution accessible.
          </p>
        </LegalSection>

        <LegalSection id="recours" title="Voies de recours">
          <p>
            Si vous constatez un défaut d’accessibilité vous empêchant d’accéder à un contenu ou une fonctionnalité, et
            qu’après nous avoir contactés vous ne parvenez pas à obtenir une réponse satisfaisante, vous pouvez saisir
            le Défenseur des droits.
          </p>
          <p>
            <a
              className="text-blue-700 underline underline-offset-2"
              href="https://formulaire.defenseurdesdroits.fr/"
              rel="noopener noreferrer"
              target="_blank"
            >
              Saisir le Défenseur des droits
            </a>
          </p>
        </LegalSection>
      </LegalPageShell>
    </LegalLayout>
  );
}

# View Transitions Plan (Next Upgrade)

## 1) Pourquoi (purpose-first)

Objectif UX:
- Rendre les changements de page plus fluides (moins de "flash" visuel).
- Ajouter des transitions d'interface cohérentes entre pages proches (liste -> détail, dashboard -> module).
- Préparer des "shared elements" (ex: titre, carte, zone de filtre) pour améliorer la continuité visuelle.

Objectif produit:
- Perception plus premium sans refonte complète.
- Réduire la charge cognitive lors des navigations fréquentes.

## 2) État actuel et contraintes

- Stack actuelle: `next@14.2.5`, `react@18.3.1`.
- Motion system CSS déjà en place (`--motion-fast`, `--motion-med`, `--ease-*`, classes `motion-*`).
- CSP stricte: pas de `style` inline, pas de `element.style.*`.
- Pas de dépendance animation prévue pour cette étape.

## 3) Ce qu'il faudra upgrader / activer plus tard

Avant toute activation:
1. Vérifier la version cible Next/React et la stabilité officielle des APIs de navigation/transitions.
2. Vérifier la compatibilité App Router + transitions dans la documentation officielle de la version retenue.
3. Activer uniquement en mode opt-in (flag) et pas globalement.

Activation technique recommandée (quand support officiel confirmé):
1. Garder le routeur existant, intercepter uniquement quelques navigations à forte valeur.
2. Enrober la navigation (push/replace) dans une fonction "transition-safe" avec fallback immédiat.
3. Ne pas bloquer la navigation si la transition échoue.

## 4) Fallback (si non supporté / navigateur incompatible)

Fallback obligatoire:
- Si API native indisponible: navigation standard immédiate.
- Si flag OFF: navigation standard immédiate.
- Si erreur runtime pendant transition: navigation standard immédiate.

Règle produit:
- Le fallback ne doit jamais changer le comportement fonctionnel.
- Les transitions sont un "enhancement", jamais une dépendance.

## 5) Intégration avec le motion system existant

Alignement recommandé:
- Durée courte pour navigation: `--motion-fast` à `--motion-med`.
- Easing: `--ease-out` pour entrée, `--ease-in` pour sortie.
- Respect `prefers-reduced-motion`: désactiver transitions de navigation.

Conventions à conserver:
- Zéro style inline.
- Réutiliser classes utilitaires existantes (`motion-fade-in`, `motion-slide-*`) pour fallback visuel.

## 6) Cibles prioritaires (phase future)

Phase 1 (faible risque):
- Marketing: navigation entre pages de même niveau (features/pricing/faq).
- App: dashboard -> pages de liste.

Phase 2 (moyen risque):
- Liste -> détail (facture, devis) avec shared element léger (titre, chip statut).

Phase 3 (plus risqué):
- Shared element complexes (cards, preview panels) avec synchronisation données.

## 7) Proto optionnel déjà posé (OFF par défaut)

Proto inert ajouté pour préparer l'intégration future:
- Flag: `NEXT_PUBLIC_ENABLE_VIEW_TRANSITIONS_PROTO` (default `false`)
- Fichier helper: `src/lib/viewTransitionsProto.js`
  - `supportsNativeViewTransitions()`
  - `runWithOptionalViewTransition(update)`

Important:
- Rien n'est activé par défaut.
- Aucun composant n'appelle encore ce helper.
- Aucun impact runtime sans activation explicite + intégration manuelle.

## 8) Checklist d’activation future

1. Confirmer support officiel Next/React sur la version cible.
2. Activer le flag uniquement en environnement de test.
3. Mesurer:
   - erreurs client,
   - perf perçue,
   - accessibilité reduced-motion.
4. Déployer progressivement (1-2 routes), puis élargir.
5. Prévoir kill-switch via flag pour rollback instantané.

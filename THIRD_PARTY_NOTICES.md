# Composants tiers

PixFacture dépend de bibliothèques et d'assets tiers qui restent soumis à leurs
propres licences. Les fichiers de verrouillage et de dépendances du frontend et
du backend donnent l'inventaire technique utilisé par chaque version.

## Polices embarquées

| Police | Emplacement | Licence |
|---|---|---|
| Inter | `backend/app/templates/static/fonts/Inter-*.ttf`, `frontend/src/assets/fonts/inter-latin.woff2` | SIL Open Font License 1.1 |
| Manrope | `frontend/src/assets/fonts/manrope-latin.woff2` | SIL Open Font License 1.1 |
| Sora | `frontend/src/assets/fonts/sora-latin.woff2` | SIL Open Font License 1.1 |
| Liberation Sans, fichiers `InvoiceSans-*.ttf` | `backend/app/templates/static/fonts/` | SIL Open Font License 1.1 |
| DejaVu Sans | `backend/app/templates/static/fonts/DejaVuSans*.ttf` | Licence DejaVu/Bitstream Vera incluse dans les métadonnées des fichiers |

Sources et textes de référence :

- Inter : https://github.com/rsms/inter
- Manrope : https://github.com/sharanda/manrope
- Sora : https://github.com/sora-xor/sora-font
- Liberation Fonts : https://github.com/liberationfonts/liberation-fonts
- DejaVu Fonts : https://dejavu-fonts.github.io/
- SIL Open Font License 1.1 : https://openfontlicense.org/

Les notices applicables aux artefacts EN 16931 sont documentées séparément dans
`backend/app/en16931/xslt/NOTICE.md`.

L'ajout d'un composant tiers doit inclure une licence compatible et les mentions
requises par son auteur.

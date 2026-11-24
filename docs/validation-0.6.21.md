# Validation 0.6.21

Date : 24 novembre 2026
Commit : `d67606f` — tag `v0.6.21`
Release : https://github.com/lasme-ephrem/lasmium-tokens-bar/releases/tag/v0.6.21

Version corrective : la ligne du bas des cartes API.

## Origine

Capture de l'utilisateur (0.6.20) : sous le solde des cartes API, la ligne
« Quota restant » affichait le montant comme un pourcentage
(« 2.3534163850000027 % » pour OpenRouter, « 2.09 % », « 5.97 % »), avec une
jauge assortie. Les relevés enregistrés étaient justes (`quotaRemaining: null`,
soldes en USD) : `card()` (`renderer/views-cards.js`) réutilisait le montant du
solde (`rawValue`) pour la ligne et la jauge du bas.

## Correction

`card()` calcule `percentLeft` : quota d'abonnement, ou part restante d'un
crédit total connu (`remaining / total`, arrondie au dixième, bornée 0–100) ;
sans total, la ligne affiche « Solde du compte » et le montant, sans jauge.
Les quotas d'abonnement sont inchangés. Le smoke `test:resources:desktop`
vérifie les deux cas (texte, absence de « % », valeur de la jauge).

## Vérifications

- Application packagée hors du dépôt, copie de l'état réel (sans clé ni
  session) : OpenRouter « Reste sur 55,00 $US · 4,3 % », jauge 4,3 ;
  DeepSeek et RightNow « Solde du compte » avec leur montant, sans jauge.
  Copie supprimée.
- `npm run lint` (0 erreur), `npm test` (**369/369**), smokes `test:desktop`,
  `test:claude:desktop`, `test:resources:desktop` (deux passages) **PASS**.

## Artefacts publiés

| Fichier | SHA-256 |
| --- | --- |
| `LasmiumTokensHub-0.6.21-win32-x64.zip` | `1f620cb4e925bbda94d9234fe7626a9ed704ba64d9a88801f13425fe2c920ea2` |
| `LasmiumTokensHub-Setup-0.6.21.exe` | `144d9f98dbb497e9f1e81a1aa500c505e787e2d52893d47124920a31d8c09abd` |

- Empreintes identiques à `SHA256SUMS-0.6.21.txt` après téléchargement du brouillon.
- `latest.json` signé localement ; signature valide avec `lib/updater-public.pem`
  et plus récent pour des clients 0.6.20 et 0.6.19 ; ZIP et installeur
  accessibles (HTTP 200).
- Workflow Release vert ; CI du commit de la version verte.
- Première mise à jour lancée par une 0.6.20 : la fenêtre PowerShell ne doit
  plus apparaître (à confirmer chez l'utilisateur).

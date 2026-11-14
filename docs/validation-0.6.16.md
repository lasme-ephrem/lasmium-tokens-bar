# Validation 0.6.16

Date : 14 novembre 2026
Commit : `90eb1d2` — tag `v0.6.16`
Release : https://github.com/lasme-ephrem/lasmium-tokens-bar/releases/tag/v0.6.16

Version corrective : Grok (xAI) est de nouveau lu.

## Origine

Depuis le 12 novembre 2026 (02:31 UTC), l'application installée gardait le
dernier relevé Grok avec l'erreur « quotas contradictoires »
(`ACCOUNT_USAGE_INVALID`, 363 échecs consécutifs). Lecture de la page réelle
avec le profil Grok de l'application, sans fenêtre et en lecture seule :

- `grok.com/dashboard` renvoie vers `accounts.x.ai/unify?src=grok_dashboard_refusal`,
  une page de blocage Cloudflare ; Lasmium bascule déjà sur `grok.com/?_s=usage`
  (aucun contournement n'a été ajouté) ;
- le panneau Paramètres → Utilisation affiche « Limite hebdomadaire SuperGrok »
  et « Weekly Grok Bot Limit » avec des pourcentages en texte (« 24 % » /
  « utilisés ») et plus aucun `number-flow-react`. Le lecteur général classait
  les deux limites sous « Semaine » avec deux valeurs différentes, d'où le conflit.

## Correction

`inspectSubscriptionPage` lit, sous chaque titre de limite hebdomadaire, le
pourcentage en texte des deux lignes suivantes, avec son libellé (« Semaine »,
« Grok Bot · Semaine ») et sa date de réinitialisation ; le détail par produit
(Imagine, App Builder) est ignoré. Ce mode texte n'est retenu que pour les deux
limites distinctes SuperGrok/Grok Bot ; les autres pages gardent le lecteur
général (une première version perdait une fenêtre de 5 heures, détectée par le
smoke `test:desktop`).

## Vérifications

- Page réelle du compte, code final : Semaine 76 % restants (réinitialisation
  18 novembre 19:14), Grok Bot · Semaine 91 % (21 novembre 15:12), sans conflit.
- Nouveau test sur le texte exact du panneau ; un titre sans total ne crée aucune
  valeur.
- `npm run lint` (0 erreur), `npm test` (**380/380**), smokes `test:desktop`,
  `test:claude:desktop`, `test:resources:desktop` **PASS** (un délai ponctuel de
  capture du smoke ressources, reproduit aussi sans la modification, a réussi à
  la relance).

## Artefacts publiés

| Fichier | SHA-256 |
| --- | --- |
| `LasmiumTokensHub-0.6.16-win32-x64.zip` | `f34cb40b07934f641477ff04c451dd1df40dde9184618757084b458f8beadf28` |
| `LasmiumTokensHub-Setup-0.6.16.exe` | `066d25e2726d8c56338773e05fff180bf137a2e4bd24fed536c5e80224c8d762` |

- Empreintes identiques à `SHA256SUMS-0.6.16.txt` après téléchargement du brouillon.
- `latest.json` signé localement ; signature valide avec `lib/updater-public.pem`
  et plus récent pour des clients 0.6.15 et 0.6.14 ; ZIP et installeur
  accessibles (HTTP 200).
- Workflow Release vert ; CI du commit de la version verte.

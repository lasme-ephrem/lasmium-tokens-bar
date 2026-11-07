# Validation 0.6.14

Date : 7 novembre 2026
Commit : `1c873a8` — tag `v0.6.14`
Release : https://github.com/lasme-ephrem/lasmium-tokens-bar/releases/tag/v0.6.14

Version corrective : la connexion Claude est renouvelée en arrière-plan par
Claude Code, et Ollama est de nouveau lu.

## Origine

- Claude : à chaque expiration de la connexion (environ 8 h), le bandeau de
  reconnexion revenait ; l'utilisateur devait ouvrir un terminal, taper `claude`
  et faire confiance au dossier pour qu'il disparaisse. L'échange OAuth direct de
  Lasmium restait refusé (HTTP 429 durable), alors que Claude Code renouvelle son
  propre jeton sans difficulté à son démarrage.
- Ollama : plus aucune information. Lecture de contrôle dans le navigateur
  intégré, avec la connexion de l'utilisateur : `ollama.com/settings` ne contient
  plus que la consommation et la liste des modèles ; `settings/billing`
  l'abonnement et les factures ; les données d'usage sont passées sur
  `ollama.com/dashboard` (repères stables `#dashboard-plan`,
  `#dashboard-included`, `#extra-usage-balance`). Le site suit aussi désormais
  la langue (français), et Electron lève « Redirect was cancelled » sur une
  redirection en mode manuel.

## Correction

- `claude-cli.cjs` : `renewConnection()` lance `claude -p "Réponds uniquement : OK"
  --model haiku --no-session-persistence --tools ""` dans `data/claude-code`,
  sans fenêtre, sans variables d'authentification, délai de 90 s.
- `claude-connection.cjs` : délégation à Claude Code avant l'échange OAuth
  direct, au plus toutes les 15 minutes ; le jeton relu n'est retenu que s'il est
  valide et, après un 401, différent du jeton refusé ; l'échange direct reste un
  recours.
- `ollama-account.cjs` : `parseOllamaDashboard` (forfait, usage inclus
  left/used, crédits d'usage), lecture du tableau de bord puis repli sur
  `/settings` (repères absents ou 404) ; redirections et page de connexion
  (anglais ou français) → `OLLAMA_SIGNIN` ; forfait laissé inconnu s'il n'est pas
  affiché.
- Fixture anonymisée `tests/fixtures/ollama-dashboard-2026-11.html`.

## Artefacts publiés

| Fichier | SHA-256 |
| --- | --- |
| `LasmiumTokensHub-0.6.14-win32-x64.zip` | `27bdafc3f75e79f592c9b2f9d05367b91cf8bccdad6cd8f0e7e2ab80fc63a4cf` |
| `LasmiumTokensHub-Setup-0.6.14.exe` | `6843052a5e2156fec1db62dd7c74cbc6e617794f917c957574543645980724b6` |

- Empreintes identiques à `SHA256SUMS-0.6.14.txt` après téléchargement du brouillon.
- `latest.json` signé localement ; signature valide avec `lib/updater-public.pem`
  et plus récent pour des clients 0.6.13 et 0.6.12 ; ZIP et installeur
  accessibles (HTTP 200).
- Workflow Release vert ; CI du commit de la version verte.

## Contrôles locaux

`npm run lint` (0 erreur), `npm test` (**374/374**), smoke `test:desktop`,
`test:claude:desktop` (dont renouvellement en arrière-plan par Claude Code sans
bannière) et `test:resources:desktop` **PASS**.

- Lecteur Ollama appliqué à la page réelle de l'utilisateur : forfait Free,
  usage inclus 100 %, crédits d'usage 1,05 USD.
- Commande de renouvellement exécutée sur le PC de l'utilisateur avec Claude Code
  connecté à l'abonnement : code de sortie 0 en 4 s, sans demande de confiance du
  dossier.

## À constater chez l'utilisateur

Le renouvellement sur un jeton réellement expiré n'a pas été provoqué (le fichier
`~/.claude/.credentials.json` n'est pas modifié pour un test) : il sera constaté
à la prochaine expiration, sans bandeau ni terminal à ouvrir.

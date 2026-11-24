# Validation 0.6.19

Date : 24 novembre 2026
Commits : `6361c4d` (Antigravity), `39a257e` (RightNow) — tag `v0.6.19`
Release : https://github.com/lasme-ephrem/lasmium-tokens-bar/releases/tag/v0.6.19

Version corrective : Antigravity 2.34 de nouveau lu ; RunInfra devient RightNow.

## Antigravity 2.34

- Origine : depuis le 20 novembre 2026, `ANTIGRAVITY_NO_PORTS` à chaque
  lecture. Antigravity 2.34 lance `language_server.exe` sans `--csrf_token`
  (`--read_host_bridge_token_from_stdin`) ; sans jeton, le service répond
  « missing CSRF token ».
- Le service écrit `~/.gemini/antigravity/daemon/hub_<port>.json`
  (`pid`, `httpsPort`, `httpPort`, `csrfToken`). `discoverServers` lit
  désormais le fichier dont le `pid` est celui du service vérifié (fichiers
  d'anciennes sessions ignorés), interroge le port HTTPS en premier et exclut le
  port HTTP. Le jeton reste en mémoire.
- Vérifié : lecture réelle (Gemini 97 % / 99 %, Claude et GPT 99 % / 100 %) ;
  application packagée hors du dépôt, données vierges, « Connecter
  Antigravity » : 4 fenêtres, notification « Quotas Antigravity actualisés. »,
  aucune erreur.

## RunInfra devient RightNow

- Sources officielles : le site runinfra.ai indique « Part of RightNow » et
  « © 2026 RightNow AI, Inc. » ; la documentation RightNow précise que des noms
  commencent par `runinfra` « from the platform's earlier name ». API de crédits
  documentée : `GET https://api.rightnowai.co/v1/credits` (centimes USD, même
  format). Logo : `rightnow-avatar-dark.svg` de https://www.rightnowai.co/brand,
  non modifié.
- Changements : nom RightNow, monogramme RN, couleur `#76b900` (migration
  `normalizeProviderPresentation`, identifiant `runinfra` conservé), endpoint et
  pack signé `2026.11.2`, logo `assets/providers/rightnow.svg`, textes, messages
  d'erreur et documentation.
- Vérifié sur l'application packagée hors du dépôt, avec une copie des données
  réelles (état, clé chiffrée, `Local State`) : RunInfra → RightNow, requête vers
  `api.rightnowai.co/v1/credits`, solde réel lu (5,97 USD), carte « RightNow »,
  logo chargé, aucune erreur. Copie supprimée, clé comprise.

## Contrôles

`npm run lint` (0 erreur), `npm test` (**368/368**), smokes `test:desktop`,
`test:claude:desktop`, `test:resources:desktop` **PASS** (le smoke ressources a
connu un délai de capture ponctuel, déjà observé sur du code inchangé, puis deux
passages réussis).

## Artefacts publiés

| Fichier | SHA-256 |
| --- | --- |
| `LasmiumTokensHub-0.6.19-win32-x64.zip` | `43bfd6ddb58d318d7e0848cf923168d9158f891285ede8ba8bd065ca141fb3be` |
| `LasmiumTokensHub-Setup-0.6.19.exe` | `96dde70e3d77227989c01dc27a07564a6ef603fdec09d5d91c8d99ddeb26d036` |

- Empreintes identiques à `SHA256SUMS-0.6.19.txt` après téléchargement du brouillon.
- `latest.json` signé localement ; signature valide avec `lib/updater-public.pem`
  et plus récent pour des clients 0.6.18 et 0.6.17 ; ZIP et installeur
  accessibles (HTTP 200).
- Workflow Release vert ; CI du commit de la version verte.

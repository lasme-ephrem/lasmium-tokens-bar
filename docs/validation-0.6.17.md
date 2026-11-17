# Validation 0.6.17

Date : 18 novembre 2026
Commit : `f49a3a1` — tag `v0.6.17`
Release : https://github.com/lasme-ephrem/lasmium-tokens-bar/releases/tag/v0.6.17

Version de retrait : OrcaRouter n'est plus suivi, à la demande du propriétaire.

## Changements

- `migrations.cjs` : `orcarouter` ajouté à `removedProviderIds` ; le retrait
  couvre la fiche, l'historique, `connectorHealth` et `apiCooldowns`, après copie
  intégrale dans `state.before-subscription-removal.json` (`wx`).
- `data-store.cjs` : `legacyOrcaRouter` signale une ancienne fiche ; `main.cjs`
  vide alors la partition `persist:orcarouter-account`. Le profil
  `account-browsers/orcarouter` est supprimé à chaque démarrage tant qu'il existe.
- Supprimés : `lib/orca-account.cjs`, connexion Chrome/Edge et fenêtre intégrée
  (`provider-flows.cjs`, `account-browser.cjs`), IPC `orca:*`, codes `ORCA_*`,
  stratégie `orca-session`, origines OrcaRouter de l'allowlist, entrée du
  catalogue, de l'inventaire initial et logo.
- Tests et smokes adaptés : neuf fournisseurs (six abonnements, trois API) ; le
  scénario P0-5 (panne passagère, session conservée) est désormais vérifié sur
  Ollama ; la détection de fin de connexion (profil `lockfile`, échec au
  lancement) est testée sur Ollama.

## Vérifications

- Application packagée, lancée hors du dépôt sur une **copie de l'état réel**
  de l'utilisateur (aucune session ni clé copiée) et un faux profil OrcaRouter :
  10 → 9 fournisseurs, 1 832 relevés OrcaRouter retirés, historique des autres
  fournisseurs intact (+2 relevés automatiques pendant l'essai), santé OrcaRouter
  retirée, sauvegarde intégrale présente (10 fournisseurs, 1 832 relevés),
  profil OrcaRouter supprimé et profil Ollama conservé, 9 cartes affichées,
  aucune trace d'OrcaRouter dans l'interface ni dans l'IPC, aucune erreur de
  page. Copie de test supprimée ensuite.
- `npm run lint` (0 erreur), `npm test` (**365/365**), smokes `test:desktop`,
  `test:resources:desktop` et `test:claude:desktop` **PASS**.
- Smoke Claude : échec intermittent préexistant (constaté 2 fois sur 3 sur le
  code 0.6.16) : la notification « Claude connecté à ton abonnement » est parfois
  remplacée par « Relevé Claude récupéré. », émise par la mise à jour d'état.
  Sans lien avec ce retrait ; à corriger séparément.

## Artefacts publiés

| Fichier | SHA-256 |
| --- | --- |
| `LasmiumTokensHub-0.6.17-win32-x64.zip` | `4d9bb87ef11d6786d05df1af8f14175f6e377ca82a1308e014b8c365595dba9e` |
| `LasmiumTokensHub-Setup-0.6.17.exe` | `ad2be79badd319ed6c34ce50772718f4c681ac7dafc1314715c08d4dca160867` |

- Empreintes identiques à `SHA256SUMS-0.6.17.txt` après téléchargement du brouillon.
- `latest.json` signé localement ; signature valide avec `lib/updater-public.pem`
  et plus récent pour des clients 0.6.16 et 0.6.15 ; ZIP et installeur
  accessibles (HTTP 200).
- Workflow Release vert ; CI du commit de la version verte.

# Architecture

`main.cjs` (processus principal Electron) gère le cycle de vie, les fenêtres, la zone de notification, la surface IPC et l’état en mémoire. Il délègue au reste de `lib/` : stockage et migrations, sécurité des fenêtres et du dossier de données, export nettoyé, connecteurs, diagnostic. Les parcours d’authentification fournisseur sont dans `lib/provider-flows.cjs`, l’orchestration des synchronisations et le disjoncteur dans `lib/connector-sync.cjs`. Le renderer utilise le pont explicite de `preload.cjs` : Node.js est désactivé dans les fenêtres, avec isolation du contexte, sandbox, `devTools:false` et `spellcheck:false`.

## Processus principal et cycle de vie

- **Dossier de données** : `PROVIDERSBAR_DATA_DIR`, sinon `data/` à côté de l’exécutable (packagé) ou `.local/` (développement). Il est aussi utilisé comme `userData` Electron : `state.json`, `credentials.json`, les partitions Chromium et les profils de navigateur y cohabitent.
- **Instance unique** : `app.requestSingleInstanceLock()` ; un second lancement réaffiche la fenêtre principale.
- **Démarrage** : création du dossier, restriction ACL (`lib/window-security.cjs`), chargement de l’état avec migrations (`lib/data-store.cjs`), chargement des packs signés (`lib/connector-packs.cjs`), sauvegarde de démarrage (`lib/state-backups.cjs`), initialisation du journal (`lib/logger.cjs`), purge des résidus, chargement des clés chiffrées, enregistrement de l’IPC, création des deux fenêtres, du tray, des observateurs et des timers.
- **Erreur de démarrage** : dialogue d’erreur et arrêt ; les fichiers existants ne sont jamais réinitialisés silencieusement.
- **Fenêtres** : la fenêtre principale se masque à la fermeture ; le widget est une fenêtre sans cadre, ancrée au tray, masquée au blur et dimensionnée sur son contenu. Les fenêtres de connexion internes (OrcaRouter, Ollama) sont sandboxées, sans preload, avec partition persistante et liste fermée d’origines.
- **Timers** : échéance Claude toutes les 2 s (vérifie `nextAttemptAt`), expiration des abonnements toutes les 60 s, actualisation et notifications toutes les 5 min, actualisation initiale si activée ; tous `unref()` et protégés contre les exceptions. Vérification de mise à jour 60 s après le démarrage puis toutes les 6 h, uniquement lorsque l’application est packagée ou que `LASMIUM_UPDATE_MANIFEST_URL` est défini. Observateurs de fichiers sur les identifiants Claude Code (2 s) et le relevé Claude Desktop (2 s).
- **Reprise** : `powerMonitor` (`resume`, `unlock-screen`) réveille la lecture Claude et déclenche une synchronisation si elle est due.
- **Arrêt ordonné** (`before-quit`) : arrêt des observateurs, fermeture des navigateurs et attente des travaux en cours, puis vidage de la file d’écriture (`store.settle()` et `credentials.settled()`), avant l’arrêt effectif.
- **Notifications** : identité Windows via `app.setAppUserModelId` ; seuils d’échéance et de solde USD ; une alerte par jour et par motif ; calcul protégé contre un relevé sans tableau de soldes.

## Surface IPC

Tous les canaux passent par une garde unique : la frame émettrice doit être la **frame principale** de la fenêtre et son URL, paramètres retirés, doit être **exactement** le fichier `renderer/index.html` de l’installation (`main.cjs`). Aucun canal générique de fichiers, de commandes ou de réseau n’est exposé ; une clé API en clair ne circule du renderer vers le processus principal qu’au moment de `provider:connect`.

**27 canaux `ipcMain.handle`**, miroir exact dans `preload.cjs` (27 méthodes `invoke` + l’abonnement `state:changed`) :

| Domaine | Canaux |
| --- | --- |
| État et fenêtres | `state:get`, `history:get`, `window:main`, `window:quick-size`, `app:info` |
| Inventaire | `provider:update`, `provider:manual`, `provider:resets`, `provider:connect`, `provider:disconnect` |
| Synchronisation | `sync:all`, `sync:one` |
| Réglages | `settings:update` |
| Connexions de compte | `account:open`, `account:verify`, `orca:open-account`, `orca:verify-account`, `ollama:open-account`, `ollama:open-email`, `ollama:verify-account`, `claude:enable-live` |
| Données | `export`, `diagnostic`, `data:erase` |
| Mises à jour | `update:check`, `update:state`, `update:install` |

`publicState()` expose l’inventaire sans l’historique complet (`historyCount` et `historyRevision`), la destination de chaque compteur, `summary`, `desktop`, `app: { version, electron, packaged }` (sans chemin absolu) et `history:get` sert l’historique complet. L’ancien champ `strategy` (ordre de consommation retiré) n’est jamais exposé. `app:info` renvoie `{ version, electron, platform, dataDir, packaged }`, la version venant de `app.getVersion()` (source unique). `settings.theme` accepte `light`, `dark` et `system`.

## Stockage, migrations et cooldowns

`lib/data-store.cjs` porte tout ce qui touche au fichier d’état :

- **Format** : `state = { version: 1, providers, settings, history, apiCooldowns }`. Un format inconnu ou un JSON illisible fait échouer le démarrage ; l’application ne réinitialise jamais l’état à la place de l’utilisateur.
- **Écriture atomique sérialisée** : fichier `.tmp` puis `rename`, mode `0o600`, file d’écriture unique ; `settle()` permet un arrêt propre. Les identifiants suivent le même chemin (`credentials.json`).
- **Migrations idempotentes** exécutées dans l’ordre historique : nettoyage des métadonnées d’import, ajout d’Antigravity puis de Claude, retrait des services obsolètes **et de l’ancien champ `strategy`** (ordre de consommation retiré), normalisation de présentation, normalisation du thème, initialisation non destructive des cooldowns, expiration des abonnements, purge des relevés OrcaRouter invalides, plafonnement de l’historique.
- **Sauvegardes** : `state.before-subscription-removal.json` et `state.before-orca-balance-fix.json`, écrites avec le drapeau `wx` (jamais écrasées) ; la purge de démarrage ne conserve que les deux sauvegardes les plus récentes.
- **Historique** : plafonné à **20 000** relevés (`HISTORY_LIMIT`), les plus anciens purgés au chargement et à chaque écriture.
- **Clés API** : chiffrées par `safeStorage`/DPAPI, base64 dans `credentials.json`, décryptées en mémoire uniquement pour un appel ; le store ne publie une valeur qu’après l’écriture disque réussie (`lib/credential-store.cjs`).
- **Cooldowns 429** : `state.apiCooldowns` mappe `<fournisseur>:<sha256(clé)>` vers une échéance en millisecondes, plafonné à 100 entrées. `main.cjs` fournit à `fetchUsage` un store synchrone `{ get, set, prune }` adossé à cet objet ; la valeur est écrite immédiatement sur 429 et purgée avant chaque lecture. Les cooldowns Ollama/Orca restent gérés en mémoire par leurs modules respectifs (aucune duplication d’état).

## Sécurité des fenêtres et des sessions

`lib/window-security.cjs` :

- `secureWindow(win)` : navigation refusée, `window.open` refusé, permissions refusées (requête et vérification), garde `devtools-opened`.
- `secureAccountWindow(win, allowedOrigins)` : navigation, redirections et popups limitées à une **allowlist d’origines HTTPS** (Ollama, OrcaRouter, connexion Google) ; les fenêtres créées héritent des mêmes règles et des webPreferences durcies.
- `applyDataDirAcl(dataDir)` : sous Windows, `icacls /inheritance:r` puis droits complets pour l’utilisateur courant et `SYSTEM` ; délai borné et échec non bloquant (avertissement).
- `purgeLeftovers(dataDir)` : fichiers `.tmp`, `DevToolsActivePort` obsolète (préservé en mode diagnostic), sauvegardes au-delà de deux, profils `temporary-account-browsers` (délégation à `sweepTemporaryProfiles` de `account-browser.cjs`, sinon suppression directe).

**Sessions navigateur** : chaque fournisseur web utilise un profil Chrome/Edge dédié ou une partition Electron. Les lecteurs pilotent le navigateur par **`--remote-debugging-pipe`** (messages JSON terminés par NUL) : aucun port TCP de débogage n’est ouvert. Un port local n’existe qu’en **mode diagnostic explicite** (`--remote-debugging-port=0`), utilisé par `npm run verify:connections` et `npm run update:portable` ; pour cette raison, la purge de démarrage ne supprime pas `DevToolsActivePort` lorsque ce mode est actif.

## Export et effacement

`lib/privacy-export.cjs` transforme l’état en document autonome `{ app, version, exportedAt, inventory, settings, manualResets, history }` : les clés `accountSession`, `claudeSync`, `apiCooldowns`, `identity`, `email`, `emailHash`, `userId`, `workspaceId` sont retirées récursivement, et l’ancien champ `strategy` n’est pas exporté ; les compléments de date sont regroupés à part, par fournisseur. L’export ne contient ni clé, ni cookie, ni jeton. Aucune restauration n’est proposée.

`data:erase` (double confirmation côté interface) refuse de s’exécuter pendant une synchronisation ou une déconnexion, ferme les navigateurs et fenêtres de connexion, vide les partitions et le store de clés, supprime état, identifiants, profils, sauvegardes et caches Chromium, purge les résidus, puis réinitialise l’inventaire (`createSeed()`) et rediffuse l’état. Les cooldowns mémoire Ollama/Orca sont remis à zéro via les fonctions de leurs modules.

## Connecteurs

| Module dans lib/ | Responsabilité |
| --- | --- |
| connectors.cjs | API de crédits OpenRouter, DeepSeek et RunInfra ; store de cooldowns injectable, reprises bornées |
| openai-account.cjs | codex app-server : compte, limites, connexion officielle |
| antigravity-account.cjs | Service local vérifié, méthode RetrieveUserQuotaSummary |
| subscription-accounts.cjs | Lecture ciblée des quotas Grok et Z.ai |
| account-browser.cjs | Navigateur de connexion dédié (pipe CDP), lecture en arrière-plan, purge des profils temporaires |
| subscription-controller.cjs | Coordination, annulation, priorité des vérifications interactives |
| ollama-account.cjs | Crédits mensuels et réserve supplémentaires ; codes d’erreur d’authentification/transitoires |
| orca-account.cjs | Portefeuille de l’espace de travail OrcaRouter ; codes d’erreur d’authentification/transitoires |
| provider-catalog.cjs | Métadonnées et instructions de connexion |
| diagnostics.cjs | Contrôles de prérequis lecture seule (utilisés par `scripts/doctor.cjs`) |
| claude-connection.cjs | Renouvellement OAuth de Claude Code sous verrous, écriture atomique |
| claude-live-usage.cjs | Lecture directe des quotas Anthropic (instance unique côté `main.cjs`) |
| autostart.cjs | Lancement au démarrage de Windows (Réglages et installeur `--autostart=on|off`), démarrage discret `--hidden` |
| api-spending.cjs | Suivi des dépenses API : montant de départ, recharges détectées par hausse du solde (≥ 0,50), crédits offerts, totaux du mois |
| claude-cli.cjs | Connexion à l’abonnement via Claude Code : `auth status --json`, `auth login --claudeai`, environnement sans clé API |

Claude n’a qu’une connexion : l’abonnement Claude via Claude Code (`accountSession = { kind: 'claude-live-local', plan?, email? }`). `claude-cli.cjs` trouve `claude.exe` (PATH, puis `%USERPROFILE%\.local\bin`), l’exécute sans fenêtre et retire de son environnement `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` et les bascules Bedrock/Vertex : la connexion lue est toujours `authMethod: 'claude.ai'`, sinon `not-subscription`. `auth status` ne renouvelle pas le jeton (vérifié dans Claude Code 2.1.316) : il ne sert qu’à l’identité.

`connectClaude()` (IPC `claude:enable-live` et `account:open`) interroge d’abord le statut ; si Claude Code est connecté à l’abonnement, il lit les quotas. Si le statut manque ou si la lecture répond `auth-required`, `auth-unavailable` ou `auth-refused`, il lance `claude auth login --claudeai` (navigateur, délai de 5 minutes) puis relit. `verifyClaude({ manual })` lit les quotas ; `manual` lève un cooldown d’authentification. Une ancienne session `claude-desktop-local` est convertie au démarrage ; le relevé Claude Desktop n’est plus lu.

`claude-live-usage.cjs` lit `api/oauth/usage` : `main.cjs` en crée **une instance unique** au démarrage (`createClaudeLiveReader({ fetchImpl: apiFetch, renewWithClaudeCode })`, `session.defaultSession.fetch`). La cadence est de **5 minutes** (`REFRESH_MS`) : une lecture par minute provoquait des 429 pendant des heures. Les échecs espacent les essais jusqu’à 25 minutes et respectent `Retry-After` (minimum 5 minutes). Les erreurs gardent le dernier relevé et son horodatage ; aucun repli. `p.claudeSync` ne conserve que le cooldown d’échec, restauré au démarrage et effacé à la déconnexion. L’observateur de `~/.claude/.credentials.json` (2 secondes) lève un cooldown d’authentification dès que Claude Code réécrit sa connexion. Les messages se rangent en deux familles (`RECONNECT_CODES` : bouton « Connecter Claude » ; les autres : nouvel essai automatique).

`claude-connection.cjs` renouvelle la connexion cinq minutes avant son expiration et une fois sur HTTP 401. Il délègue d’abord à Claude Code (`renewWithClaudeCode` → `claudeCli.renewConnection()` : `claude -p "Réponds uniquement : OK" --model haiku --no-session-persistence --tools ""`, cwd `data/claude-code`, 90 s, sans fenêtre ni variables d’authentification) : Claude Code renouvelle son propre jeton au démarrage, ce qui évite les 429 durables de l’échange OAuth direct. Le résultat est relu dans `~/.claude/.credentials.json` ; il est retenu seulement s’il est valide (et, après un 401, différent du jeton refusé). La délégation est tentée au plus toutes les 15 minutes (`DELEGATE_RETRY_MS`) ; sinon, ou en cas d’échec, l’échange direct suit. Il utilise le protocole du Claude Code installé (2.1.285), les scopes déjà accordés, le client existant et les verrous `.oauth_refresh.lock` et le verrou historique du répertoire (stale 60 s, heartbeat 5 s). Une seconde lecture sous verrou adopte un jeton renouvelé par un autre processus. L’écriture atomique conserve les autres champs, compare les jetons avant écriture et ne recrée pas un fichier supprimé pendant la requête. Une rotation dont l’enregistrement échoue reste en mémoire pour retenter l’écriture avant un nouvel échange. Les refus définitifs nécessitent une reconnexion dans Claude Code. Aucun jeton ne va dans les données Lasmium TOKENS-HUB.

Z.ai lit la consommation du plan. Grok lit le dashboard Usage du nouveau forfait partagé, ou le panneau Settings → Usage historique. Un pool X Subscription représente une seule réserve Grok/Bot/Cursor. Sur un compte SuperGrok présentant deux limites, `Semaine` et `Grok Bot · Semaine` restent indépendantes. Les compteurs animés sont associés à leur section et jamais pris dans les dépenses par modèle ou les crédits supplémentaires. Ces interfaces peuvent évoluer : un format inconnu produit une erreur, jamais une estimation silencieuse.

**Ollama** et **OrcaRouter** enregistrent leur session (`accountSession`) **avant** la première lecture : une erreur transitoire (`OLLAMA_RATE_LIMIT`/`OLLAMA_TRANSIENT`, `ORCA_RATE_LIMIT`/`ORCA_TRANSIENT`) conserve la connexion, le dernier relevé et `p.error`, et le cycle de 5 minutes réessaie ; une authentification refusée (`OLLAMA_SIGNIN`, `ORCA_AUTH`) efface la session pour demander une reconnexion. OrcaRouter calcule le portefeuille à partir de `active_workspace.wallet_quota` et du `quota_per_unit` fourni par le service ; `hard_limit_usd` est un plafond de clé, pas un solde. Ollama suit son usage inclus et ses crédits d’usage dans la même fiche et la même synchronisation ; un montant absent ou ambigu reste inconnu. `fetchOllamaCredits` lit d’abord `ollama.com/dashboard` (`parseOllamaDashboard` : `#dashboard-plan`, `#dashboard-included`, `#extra-usage-balance`), puis l’ancienne page `/settings` si ces repères sont absents ou si le tableau de bord répond 404. Une redirection (« Redirect was cancelled » d’Electron, `opaqueredirect`, 3xx) ou une page de connexion (anglais ou français) donne `OLLAMA_SIGNIN`.

Antigravity interroge seulement `127.0.0.1` sur les ports du processus de l’installation reconnue. L’acceptation du certificat auto-signé est limitée à cette requête locale ; le jeton CSRF reste en mémoire ; l’application Antigravity 2.0 doit être ouverte (l’IDE seul n’est pas utilisé).

Un relevé contient des soldes par devise, un quota principal et éventuellement plusieurs `quotaWindows`. Pour Antigravity, le quota principal enregistré est le minimum des limites reçues ; les cartes et le widget distinguent les trois réserves : Gemini (semaine et 5 h), Claude/GPT (semaine et 5 h) et Gemini 4 Argon (semaine). Le bucket Argon `gemini-argon-wtu-weekly` a été observé dans le service installé, sans lui inventer de fenêtre de cinq heures. Une session authentifiée et un quota lisible sont deux états distincts.

`subscriptionStatus` (`active`, `paused`, `expired`) et `statusMessage` décrivent l’état d’un abonnement indépendamment de la connexion. Une échéance dépassée fait passer automatiquement un forfait actif à `expired` au démarrage, à la lecture de l’état ou pendant que l’application reste ouverte. Le prix, la date et l’historique sont conservés. La réactivation exige une confirmation explicite et une nouvelle échéance future. Les forfaits expirés sortent du budget. Ollama reste synchronisé sous Free à 0 $ pour afficher sa limite et son montant de crédits achetés ; son ancien quota payant est invalidé.

## Interface

`renderer/index.html` charge, dans l’ordre, `theme-init.js` puis les feuilles de style, les modules partagés de `lib/` (`quota-resets.js`, `resource-levels.js`) et les scripts du renderer (`ui-core.js`, `reset-ui.js`, `views-shell.js`, `views-cards.js`, `views-pages.js`, `views-quick.js`, `app.js`). `ui-core.js` fournit échappement, formatage, icônes, thème, focus, annonces et niveaux ; les vues sont réparties par responsabilité : `views-shell.js` (coquille, navigation, en-têtes, chiffres clés, barre d’outils), `views-cards.js` (cartes fournisseur, badges d’état, santé des connexions, quotas et niveaux), `views-pages.js` (pages Vue d’ensemble, Abonnements, Connexions, Historique, Réglages et fiche détaillée) et `views-quick.js` (widget compact) ; `app.js` porte l’état, les événements, la boucle de rendu et les actions. Tous ces scripts partagent la portée globale, sans module ni bundler : l’ordre des balises `<script defer>` fait foi et `tests/quality.test.cjs` vérifie que chaque script existe, est couvert par `scripts/check-syntax.cjs` et servi par l’aperçu. Aucun script inline, aucun `eval`, aucune dépendance externe ; la CSP de `index.html` interdit les ressources distantes et `connect-src 'self'`.

La fenêtre widget est dimensionnée en **360 × 660 px** par défaut (largeur fixe, hauteur adaptée au contenu entre 240 et 900 px via `window:quick-size`) ; elle reste une fenêtre sans cadre, ancrée au tray et masquée au blur.

Le thème sombre d’origine reste dans les feuilles de style du renderer ; `renderer/theme.css` définit les tokens sémantiques clair/sombre. `settings.theme` vaut `light`, `dark` ou `system` ; `system` est résolu par `matchMedia('(prefers-color-scheme: dark)')` et suit les changements Windows en direct ; `main.cjs` aligne le fond natif via `nativeTheme.shouldUseDarkColors`. Les préférences explicites des anciens inventaires sont conservées (migration non destructive).

Le contrat d’interface détaillé (globals, hooks DOM, structure du dialogue, accessibilité, widget) est maintenu dans [renderer/CONTRAT-UI.md](../renderer/CONTRAT-UI.md). Le serveur d’aperçu expose une liste fermée de ressources publiques et un inventaire sans comptes connectés ; il ne sert jamais les dossiers de données.

## Réinitialisations

`lib/quota-resets.js` décrit les limites affichées, valide les compléments de date et choisit la provenance. `renderer/reset-ui.js` formate les dates locales et l’onglet de saisie. Les compléments persistent dans `provider.manualResets` via `provider:resets`, même pour les comptes connectés ; ils ne modifient ni le snapshot du connecteur ni l’historique.

Une date fournisseur a priorité. Un complément sans heure conserve sa précision au jour. La projection sans heure ne sert qu’à détecter une date dépassée : la borne de fin du jour local n’est jamais présentée comme l’heure réelle de reset. Les pourcentages et la fraîcheur du relevé ne sont jamais changés par un complément.

## Ordre de consommation retiré

La suggestion de modèle et l’ordre de consommation ont été **retirés du produit**. Le moteur `lib/usage-strategy.js`, l’IPC `strategy:update`, la méthode `updateStrategy` du pont `preload.cjs` et les vues associées du renderer n’existent plus. La migration non destructive `removeUnusedProviders` (`lib/migrations.cjs`), appelée par `data-store` à chaque démarrage, supprime l’ancien champ `state.strategy` des inventaires existants — y compris une configuration contenant un modèle Gemini historique — sans modifier l’inventaire, l’historique, les réglages, ni les cooldowns. `publicState()` ne l’expose pas et l’export JSON ne le contient pas. Les cartes et le widget continuent d’afficher les quotas, les soldes, la fraîcheur et les dates de réinitialisation ; ils n’affichent plus de recommandation ni de catalogue de modèles.

## Connecteurs robustes (0.5.0)

`lib/connector-contract.cjs` est pur et sans dépendance Electron : validation des relevés (`validateSnapshot`, `assertSnapshot`), classification typée des erreurs, calcul de fraîcheur sur `snapshot.updatedAt`, santé (`healthSuccess` / `healthFailure`) et disjoncteur (`breakerOpen`). `main.cjs` valide **avant** `record` : un relevé incohérent devient `SCHEMA_DRIFT` et le snapshot précédent reste intact. La santé est persistée dans `state.connectorHealth` par une migration non destructive et exposée par fournisseur dans `publicState()`.

`lib/connector-packs.cjs` charge des packs JSON signés Ed25519 depuis `assets/connector-packs/` puis `<dataDir>/connector-packs/`. Le dernier dossier gagne à version égale ; un downgrade, une signature invalide, un endpoint HTTP ou un `minApp` futur sont refusés. Les endpoints API sont passés à `fetchUsage` ; les sélecteurs DOM ne sont pas encore surchargeables. La clé publique est versionnée dans `lib/connector-packs-public.pem` ; la clé privée reste dans `.local/`.

`lib/connector-sync.cjs` porte les branches de synchronisation (OrcaRouter, Ollama, OpenAI, Antigravity, Claude, navigateur, API) et le disjoncteur. `lib/provider-flows.cjs` porte les fenêtres, timers et états des parcours Claude, Antigravity, OrcaRouter et Ollama ; `main.cjs` leur injecte les services Electron et expose leurs méthodes à l’IPC. Les décisions pures y sont exportées et testées. `lib/connector-replay.cjs` rejoue les réponses HTTP enregistrées dans `fixtures/connectors/` et les valide avec le contrat.

`lib/state-backups.cjs` copie `state.json` dans `data/backups/` au plus toutes les 6 h avant écriture (5 dernières) et restaure avec validation et copie préalable. `lib/diagnostic-bundle.cjs` produit un JSON sans secret, sans solde et sans chemin absolu. `lib/logger.cjs` écrit un journal rotatif local. Voir le [runbook](runbook-connectors.md).

## Mises à jour et canary (0.6.0)

`lib/update-manifest.cjs` définit le manifeste signé Ed25519 : JSON canonique, version, `minApp`, URL HTTPS, taille et SHA-256 de l’archive. `lib/updater.cjs` vérifie le manifeste et le téléchargement, puis délègue l’extraction à `lib/zip-extract.cjs` (refus des chemins hors racine, liens symboliques et doublons) et le remplacement à `lib/update-install.cjs`. Le script PowerShell séparé attend la fermeture, sauvegarde l’ancienne application, copie la nouvelle et relance. `data/` reste hors du périmètre de copie. La clé privée est dans `.local/updater/` ; la clé publique `lib/updater-public.pem` est versionnée. `main.cjs` instancie l’updater avec `net.fetch` (configuration réseau Windows), l’active seulement en mode packagé ou avec `LASMIUM_UPDATE_MANIFEST_URL`, vérifie 60 s après le démarrage puis toutes les 6 h, et expose trois canaux IPC : `update:check` (vérification manuelle), `update:state` (état courant : `idle`, `checking`, `available`, `downloading`, `extracting`, `ready`, `installing`, `up-to-date`, `error`, `disabled`) et `update:install` (téléchargement, extraction dans `data/updates/<version>/staging`, écriture du script d’installation, puis arrêt de l’application une fois le script démarré). Voir [updates.md](updates.md).

`lib/canary-env.cjs` charge `.local/canary.env` pour le canary live, sans écraser l’environnement et sans journaliser de clé. Le harness `scripts/connector-canary.cjs` reste hors ligne par défaut.

## Diagnostic

`lib/diagnostics.cjs` fournit des contrôles **lecture seule** et sans secret : dossier de données, chiffrement DPAPI (sonde PowerShell), navigateur Chrome/Edge, Codex, Claude Code (abonnement), service local Antigravity, puis un accès HTTP non authentifié par endpoint de fournisseur (401/403 considérés comme normaux). `scripts/doctor.cjs` les exécute (`npm run doctor`, `--json` disponible) ; seuls `data-dir` et `encryption` sont bloquants, les autres résultats sont des avertissements actionnables. `scripts/verify-connections.cjs` reste le diagnostic **réel** des connexions : il se connecte au portable lancé avec `--remote-debugging-port=0`, vérifie l’URL exacte de la fenêtre, synchronise puis écrit `test-results/connections-live.json` sans identité, clé, cookie ni montant de portefeuille.

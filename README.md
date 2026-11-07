# Lasmium TOKENS-HUB

Application desktop Windows pour suivre les abonnements, quotas et crédits de **dix fournisseurs d’IA**. Un tableau de bord et un widget dans la zone de notification regroupent les abonnements et les API avec leurs ressources restantes et leurs dates de réinitialisation.

**Version 0.6.14 — 7 novembre 2026 :** version **corrective** : la connexion Claude est renouvelée seule en arrière-plan par Claude Code (plus besoin de taper `claude` dans un terminal) et Ollama est de nouveau lu depuis son nouveau tableau de bord. Détails dans [CHANGELOG.md](CHANGELOG.md).

**Version 0.6.13 — 5 novembre 2026 :** version **corrective** : l'icône Lasmium de la barre des tâches est donnée par l'application elle-même, sans dépendre du cache d'icônes de Windows. Détails dans [CHANGELOG.md](CHANGELOG.md).

**Version 0.6.12 — 5 novembre 2026 :** version **corrective** : l'exécutable, la barre des tâches, le menu Démarrer et l'installeur affichent la marque Lasmium « L » au lieu de l'ancienne icône ProvidersBar. Détails dans [CHANGELOG.md](CHANGELOG.md).

**Version 0.6.11 — 5 novembre 2026 :** **installation et finitions** : installeur Windows (par utilisateur, sans administrateur), lancement au démarrage de Windows, icône Lasmium sur l'exécutable et barre du haut façon VS Code. Détails dans [CHANGELOG.md](CHANGELOG.md).

**Version 0.6.10 — 5 novembre 2026 :** version **corrective** : Ollama suit le forfait lu sur son site (Free = 0 $, forfait payant compté même après son échéance), textes d'un abonnement terminé harmonisés, smoke Claude fiable en CI. Détails dans [CHANGELOG.md](CHANGELOG.md).

**Version 0.6.9 — 5 novembre 2026 :** **coûts en clair** : fiche d'abonnement à quatre champs (forfait, prix, fréquence, échéance), coût mensuel et paiements uniques distingués, suivi des dépenses API par recharges détectées, fiche API réduite à la clé. Détails dans [CHANGELOG.md](CHANGELOG.md).

**Version 0.6.8 — 5 novembre 2026 :** **connexion Claude simplifiée** : un bouton « Connecter Claude », comme pour Codex, toujours sur ton abonnement (jamais une clé API) ; lecture toutes les 5 minutes avec Hebdo Fable ; Claude Desktop n'est plus utilisé. Détails dans [CHANGELOG.md](CHANGELOG.md).

**Version 0.6.7 — 5 novembre 2026 :** version **corrective** : après un repli vers Claude Desktop, la lecture directe Claude (et donc **Hebdo Fable**) reprend seule dès que Claude Code renouvelle son jeton ; dates de réinitialisation et réserve Ollama mieux séparées. Toutes les fonctionnalités 0.6.6 sont conservées ; détails dans [CHANGELOG.md](CHANGELOG.md).

**Version 0.6.6 — 5 novembre 2026 :** version **Qualité** : correction d'un timer orphelin du navigateur de connexion Ollama, URL de mise à jour vers le dépôt renommé, CI fusionnée et workflow de release automatisé, ESLint, 352 tests, renderer découpé. Toutes les fonctionnalités 0.6.5 sont conservées ; détails dans [CHANGELOG.md](CHANGELOG.md).

**Version 0.6.5 — 4 novembre 2026 :** **mise à jour automatique signée** du portable, vérifiée par manifeste Ed25519 et SHA-256, avec remplacement après fermeture et conservation stricte de `data/` ; **canary live** prêt à recevoir des clés de test locales. Toutes les fonctionnalités 0.5.0 sont conservées. Détails dans [CHANGELOG.md](CHANGELOG.md), [updates.md](docs/updates.md), la [matrice fournisseurs](docs/provider-matrix.md) et le [runbook](docs/runbook-connectors.md).

## Maintenance 0.6.14

- **Claude** : renouvellement délégué à Claude Code en mode silencieux (`claude -p`, Haiku, sans outil ni session enregistrée) avant tout échange OAuth propre, au plus toutes les 15 minutes.
- **Ollama** : lecture de `ollama.com/dashboard` (`#dashboard-plan`, `#dashboard-included`, `#extra-usage-balance`), repli sur `/settings` ; redirections traitées comme session expirée.
- **Qualité** : 374 tests, lint sans erreur, trois smoke tests Windows.

## Maintenance 0.6.13

- **Barre des tâches** : icône fournie par la fenêtre (`setAppDetails`, `assets/icon.ico` livré) ; raccourcis de l'installeur sur ce même fichier.

## Maintenance 0.6.12

- **Icône** : `assets/icon.ico` construit depuis `assets/icon.png` (marque Lasmium) par `python scripts/generate-icon.py` ; un test refuse l'ancienne icône ProvidersBar.

## Maintenance 0.6.11

- **Installation** : installeur Inno Setup par utilisateur publié avec chaque release ; lancement au démarrage (installeur et Réglages, démarrage discret `--hidden`).
- **Interface** : barre du haut intégrée (boutons Windows natifs), recherche au centre, actions Synchroniser, widget, thème, Réglages et « Mettre à jour ».
- **Exécutable** : icône et informations de version de Lasmium TOKENS-HUB (ressources réécrites par `resedit`).
- **Qualité** : 365 tests, lint sans erreur, trois smoke tests Windows.

## Maintenance 0.6.10

- **Ollama** : statut déduit du forfait lu (Free ou payant), plus de bascule en Free à la date d'échéance ; un arrêt choisi n'est pas annulé par le forfait encore affiché jusqu'à la fin de la période réglée.
- **Interface** : « Abonnement terminé » partout sur la carte d'un abonnement arrêté.
- **CI** : conversion de l'ancienne session Claude au chargement ; smokes en échec toujours terminés.
- **Qualité** : 357 tests, lint sans erreur, trois smoke tests Windows.

## Maintenance 0.6.9

- **Abonnements** : quatre champs, deux onglets ; récurrents par mois, paiements uniques à part ; une échéance dépassée passe « à vérifier » au lieu d'arrêter le suivi.
- **API** : la clé seulement, et un suivi des dépenses par recharges détectées (crédits offerts exclus).
- **Données** : champs saisis à la main retirés après une copie complète de `state.json`.
- **Qualité** : 355 tests, lint sans erreur, trois smoke tests Windows ; migration vérifiée sur une copie de données réelles.

## Maintenance 0.6.8

- **Claude** : connexion par Claude Code uniquement (`claude auth status` puis, si besoin, `claude auth login --claudeai`), sans clé API ni jeton longue durée ; lecture toutes les 5 minutes ; fiche à trois états et un seul message. Le relevé Claude Desktop et le repli sont retirés.
- **Qualité** : 348 tests, lint sans erreur, trois smoke tests Windows.

## Maintenance 0.6.7

- **Claude** : le repli vers Claude Desktop (jeton Claude Code non renouvelé) n'est plus définitif. La lecture directe est relancée dès que Claude Code réécrit son jeton, sinon au plus tous les quarts d'heure, sans erreur affichée entre deux essais ; la carte et la fiche annoncent le repli et l'absence d'Hebdo Fable.
- **Affichage** : « Le 12 nov. à 13:20 · dans 6 j 23 h » et « Réserve supplémentaire : 1,05 $US » au lieu de textes collés.
- **Qualité** : 355 tests, lint sans erreur, trois smoke tests Windows.

## Maintenance 0.6.6

- **Corrections** : un timer de détection du navigateur système Ollama pouvait survivre à une annulation et interroger tout navigateur ouvert ensuite ; l'URL du manifeste de mise à jour vise désormais `lasme-ephrem/lasmium-tokens-bar` au lieu de l'ancien nom du dépôt.
- **Livraison** : `quality.yml` fusionné dans `ci.yml` ; nouveau workflow `release.yml` (fabrication sur Windows, contrôle de l'archive par réextraction, notes tirées du CHANGELOG, brouillon de release GitHub, signature de `latest.json` si un secret est fourni). Voir [updates.md](docs/updates.md).
- **Qualité** : ESLint derrière `npm run lint`, 352 tests dont les tests de l'updater exécutables sur toute plate-forme, `views.js` découpé en quatre fichiers, `publicState()` lisible. Validation Windows complète (tests, lint, trois smoke tests).

## Maintenance 0.6.5

- **Correctifs d'extraction** : l'entrée racine `./` produite par `tar -C dossier .` est ignorée, et les fichiers `.asar` sont écrits dans un fichier temporaire puis renommés pour contourner le patch `fs` d'Electron qui les interprète comme des archives. Ces deux correctifs, plus l'autorisation du staging sous `data/updates/`, rendent l'auto-update réellement opérationnel.
- **Démarrage fiable du script d'installation** : lancement via le shell Windows, script détaché, accusé de démarrage avant fermeture. L'application ne quitte qu'après cet accusé.
- **Mise à jour automatique** : l'application vérifie un manifeste HTTPS signé, télécharge l'archive, contrôle sa taille et son SHA-256, refuse les archives piégées (chemins `..`, liens symboliques, `data/`), puis un script séparé remplace l'application après fermeture. L'ancienne version reste disponible pour un rollback et `data/` n'est jamais touché. **Réglages → Mises à jour** permet aussi une vérification manuelle.
- **Canary live** : `npm run connectors:canary:live` charge `.local/canary.env` (ignoré par Git) sans écraser les variables d'environnement. Aucune clé n'est journalisée ; l'absence de clé est signalée sans faux succès.
- **Qualité** : 269 tests, tests dédiés au manifeste, à l'extraction ZIP (entrée racine `./` et fichiers `.asar`), au script d'installation et au canary. Flux réel 0.6.0 → 0.6.5 validé dans [validation-0.6.5.md](docs/validation-0.6.5.md).

## Robustesse 0.5.0

- **Un relevé illisible ne devient jamais un faux zéro** : il est classé `SCHEMA_DRIFT` et le dernier relevé sain est conservé. La santé de chaque fournisseur (état, stratégie, âge, prochaine tentative) est persistée et visible dans **Connexions**. Les réponses HTTP enregistrées sont rejouées dans les tests.
- **Disjoncteur** : l'actualisation automatique espace les pannes (30 s → 30 min) au lieu de marteler le fournisseur ; **Tester** et **Synchroniser** forcent une tentative immédiate.
- **Packs signés** : endpoints et métadonnées de parseur peuvent être corrigés via un pack local signé, sans reconstruire l'application. Un pack altéré, non signé, HTTP ou plus ancien est refusé. Outillage `connectors:sign`, `connectors:key`, `connectors:canary`.
- **Données** : sauvegardes rotatives de `state.json` (5 dernières), restauration contrôlée avec copie préalable, bundle de diagnostic sans clé ni solde, journal local rotatif.
- **Architecture** : parcours fournisseur dans `lib/provider-flows.cjs`, synchronisation et disjoncteur dans `lib/connector-sync.cjs` ; `main.cjs` ne garde que le cycle de vie, les fenêtres, l'IPC et l'état.
- **Qualité** : 252 tests, smoke Electron étendu à la santé et à la dérive, CI Windows.

## Refonte 0.4.0

- **Nouveau nom et logo** : l'application s'appelle **Lasmium TOKENS-HUB**. Le logo Lasmium (monogramme lumineux) remplace l'ancienne marque dans la fenêtre, le widget, la zone de notification et l'icône Windows.
- **Nouveau design system** : navigation « obsidian rail » sombre dans les deux thèmes, contenu clair ou sombre, accent lime laser, cartes aérées, chiffres Sora, états et chips repensés, panneau de fiche latéral.
- **Refonte du widget** : identité Lasmium, lignes verticales complètes, meilleure hiérarchie et barre fine conservée.
- **Renommage et nettoyage** : API renderer `window.lasmium`, variable `LASMIUM_DATA_DIR` (repli `PROVIDERSBAR_DATA_DIR`), suppression du code mort (projection `forStrategy`, ancien CSS du widget), documentation réorganisée. Le dossier portable historique `dist/ProvidersBar-win32-x64/` est conservé pour préserver les données.

## Correctif 0.3.6

- **Toutes les informations par ligne** : le widget n'agrège plus les fenêtres et n'affiche plus de compteur « +N ». Chaque abonnement est une ligne verticale (logo, nom, chip de niveau) suivie d'une ligne par information : Claude **Hebdo / Horaire / Hebdo Fable**, Antigravity **Gemini · Hebdo**, **Gemini · Horaire**, **Claude / GPT · Hebdo**, **Claude / GPT · Horaire**, **Hebdo Argon**.
- **Ollama visible** : « Limite Free » (quota) et « Crédits achetés » (réserve en USD) sont désormais affichés, au lieu d'un simple « — ». Une information unique (OpenAI, Grok, API mono-solde) reste sur la ligne d'en-tête pour garder le widget compact.
- **API complètes** : tous les soldes sont listés, devise par devise (DeepSeek USD + CNY, RunInfra, OrcaRouter, OpenRouter), avec la couleur de niveau et le détail en infobulle.
- **Dimensions** : fenêtre **360 × 660**, lignes de 28 à 115 px selon le nombre de fenêtres, icônes 18 px, dix fournisseurs visibles **sans défilement** (barre fine de 5 px seulement si la fenêtre est réduite).

## Correctif 0.3.5

- **Segmentation des abonnements** : chaque abonnement montre ses fenêtres réellement disponibles — **Hebdo** (semaine) et **Horaire** (5 heures), ou seulement celle qui existe. Claude affiche **Hebdo**, **Horaire** et **Hebdo Fable** ; Antigravity affiche Gemini (Hebdo + Horaire), Claude/GPT (Hebdo + Horaire) et **Argon → Hebdo Argon**. Plus de libellé ambigu « 5 h » ni de ligne vide pour une fenêtre absente.
- **Widget** : la segmentation est résumée sur deux segments maximum par ligne (les plus contraints), le détail complet restant accessible dans l’infobulle et aux lecteurs d’écran ; les dix fournisseurs restent visibles sans défilement à 360 × 520 (porté à 360 × 660 en 0.3.6 pour tout afficher).
- **Statuts soignés** : les niveaux « Suffisant / Bas / Critique / Épuisé / Indisponible » sont rendus par un chip discret (fond teinté léger, bordure, pastille, texte conservé pour l’accessibilité et le contraste), identique dans les cartes, le widget, la fiche et la légende des Réglages.
- **Police** : **Inter Variable** (SIL OFL 1.1) est embarquée dans `assets/fonts/` et appliquée au tableau de bord et au widget, avec repli Segoe UI/system-ui et chiffres tabulaires ; aucun téléchargement au lancement.

## Correctif 0.3.4

- **Recommandations supprimées** : plus de panneau « Ton ordre d’usage », de suggestions « Utilise maintenant / Puis », de classement des API ni de réglage d’ordre de consommation. Le tableau de bord et le widget **listent** les abonnements et les API avec leurs soldes ; le catalogue de modèles et tarifs embarqué est retiré (application plus simple, données et code en moins).
- **Widget compact** : fenêtre **360 × 520 px** (portée à **360 × 660** en 0.3.6 pour afficher toutes les fenêtres), lignes de 32 à 36 px selon la segmentation, icônes 20 × 20 visibles, liste Abonnements puis API ; les dix fournisseurs tiennent **sans défilement** dans la fenêtre par défaut, le défilement (barre fine de 5 px) n’apparaît que si la fenêtre est réduite ou la police agrandie.
- **Données** : la stratégie/ordre de consommation est retirée des inventaires existants par migration non destructive ; l’export JSON ne contient plus `strategy` ; l’IPC `strategy:update` et la méthode `updateStrategy` sont supprimés.

## Correctif 0.3.3

- **Claude** : si la lecture directe échoue (renouvellement du jeton Claude Code limité) et que le dernier relevé date de plus de 10 minutes, Lasmium TOKENS-HUB **bascule explicitement** en lecture Claude Desktop et l’annonce, au lieu de rester bloqué sur un ancien relevé. Un relevé frais (< 10 minutes) n’est jamais remplacé. En repli, un relevé Desktop de plus de 45 minutes est affiché avec sa date réelle et la mention « relevé ancien » (jamais présenté comme frais) ; le mode Desktop reste actif pour que le prochain relevé écrit par Claude Desktop soit récupéré automatiquement.
- **Lecture directe Claude** : reste disponible si tu renouvelles le jeton dans Claude Code (ou via `claude auth login`), puis en réactivant « Activer la lecture directe » ; le repli Desktop ne l’empêche pas.

## Correctif 0.3.2

- **Ollama** : le portail `ollama.com/settings` a changé de structure (« Usage breakdown », « Free usage 0 % used », badge « Pay as you go »). Le lecteur reconnaît désormais cette page : quota Free restant et solde de crédits achetés (ex. 1,05 USD) sont affichés, sans inventer de crédits mensuels inclus. Les anciennes pages payantes restent prises en charge.
- **OrcaRouter** : « Vérifier maintenant » fonctionne avec la session déjà enregistrée, **sans exiger l’ouverture de la fenêtre de connexion**, et ne peut plus supprimer une session valide lors d’un simple contrôle. La fenêtre n’est utilisée que pour une connexion neuve ou un changement de compte/espace ; les erreurs d’authentification, de débit ou transitoires sont annoncées clairement et le dernier relevé est conservé. Les boutons génériques d’ouverture/vérification routent correctement OrcaRouter et Ollama.
- **OpenRouter** : un **découvert** (crédits consommés supérieurs aux crédits achetés, par exemple 45,08 USD utilisés pour 45,00 USD achetés) n’est plus traité comme une réponse invalide. Le solde restant négatif est affiché comme épuisé et la clé de gestion peut être enregistrée ; les réponses réellement incohérentes restent refusées.

## Correctif 0.3.1

- **Claude Desktop** : le relevé `plan-usage-history.json` est aussi lu dans le nouveau profil `%LOCALAPPDATA%\Claude-Data\<profil>\` des versions récentes de Claude Desktop, en plus des emplacements historiques. La connexion Claude retrouve donc immédiatement les quotas sans dépendre du renouvellement du jeton Claude Code.
- **Antigravity** : la découverte du service local n’utilise plus un filtre de sockets défaillant sur certaines machines ; elle interroge les ports **du processus vérifié** (avec repli) et distingue « application fermée » de « service visible mais ports illisibles ». La lecture réelle des fenêtres Gemini, Claude/GPT (et Argon lorsqu’il est exposé par le compte) fonctionne à nouveau.
- **Claude lecture directe** : un 429 du **renouvellement OAuth** est désormais distinct (`auth-rate-limit`) d’un 429 de l’endpoint d’usage, avec un message actionnable ; le `Retry-After` n’est pas contourné au réveil de veille. Si aucun relevé n’existe, le repli explicite vers Claude Desktop est annoncé au lieu de laisser la fiche vide.

## Ce qui change en 0.3.0

- **Connexions plus fiables** : une session Ollama ou OrcaRouter est conservée dès qu’elle est validée, même si la lecture échoue temporairement ; le cycle d’actualisation réessaie seul au lieu de demander une reconnexion. Les cooldowns 429 des clés API survivent au redémarrage.
- **Claude jamais bloqué** : si la lecture directe échoue (jeton Claude Code expiré, renouvellement limité ou refusé) alors que le dernier relevé direct est **absent ou périmé (plus de 10 minutes)**, Lasmium TOKENS-HUB bascule explicitement vers le relevé Claude Desktop et l’annonce, même si un ancien relevé existe — il est périmé, rien de valable à préserver. Un relevé Desktop de plus de 45 minutes reste affiché avec sa date réelle et signalé comme ancien.
- **Session navigateur durcie** : les lecteurs de comptes pilotent Chrome/Edge par un **pipe local** (plus de port TCP de débogage) ; la première connexion se fait dans un navigateur ordinaire, sans port de débogage, et les fenêtres de connexion internes n’acceptent qu’une **liste fermée d’origines** (fournisseurs concernés et connexion Google).
- **Diagnostic intégré** : `npm run doctor` vérifie en lecture seule les prérequis (dossier de données, DPAPI, navigateur, Codex, Claude, Antigravity, accès réseau aux API).
- **Interface redessinée et accessible** : thèmes clair / sombre / **système**, contrastes AA, navigation jamais masquée, widget compact avec statut d’actualisation réel et indicateur de relevé ancien.
- **Données maîtrisées** : export JSON nettoyé (sans clés, sessions ni identifiants), action **Effacer mes données** avec double confirmation, dossier de données à ACL restreinte, purge automatique des fichiers résiduels.

## Utiliser l’application

**Installer** : télécharger `LasmiumTokensHub-Setup-<version>.exe` depuis la [dernière release](https://github.com/lasme-ephrem/lasmium-tokens-bar/releases/latest) et le lancer. L’installation se fait dans ton profil (`%LOCALAPPDATA%\Programs\LasmiumTokensHub`), sans droits administrateur, avec raccourcis menu Démarrer (et Bureau en option) et la case **« Lancer au démarrage de Windows »** : l’application s’ouvre alors discrètement dans la zone de notification. Le lancement au démarrage se change aussi dans **Réglages**. L’installeur n’étant pas signé, Windows SmartScreen peut demander « Informations complémentaires → Exécuter quand même ». La désinstallation (Paramètres Windows → Applications) demande si tes données doivent être conservées. Les mises à jour automatiques signées continuent de fonctionner sur l’application installée.

Version portable : lancer **`Lancer Lasmium TOKENS-HUB.cmd`** (portable personnel) ou `dist/ProvidersBar-win32-x64/LasmiumTokensHub.exe` (dossier historique conservé pour les données). Conserver tout le dossier du portable : Node.js n’est pas nécessaire sur le PC qui l’utilise. Le dossier `dist/` est généré et exclu de Git ; pour produire une distribution propre, voir la section « Fabriquer et mettre à jour » ci-dessous.

1. **Connexions** : connecter les comptes et renseigner les clés API.
2. **Vue d’ensemble** : cartes par fournisseur, ressources restantes, prochaine réinitialisation.
3. **Abonnements** : prix, échéances, périodicité et budget mensuel.
4. **Réglages** : actualisation automatique, notifications, thème (Clair / Sombre / Système), version, effacement des données.

Fermer la fenêtre conserve l’application dans la zone de notification. Un clic sur l’icône ouvre le widget ; clic droit → **Quitter** arrête l’application. L’historique et l’export JSON restent accessibles depuis le tableau de bord.

Les pourcentages indiquent les **quotas restants**. Une valeur absente reste inconnue. Chaque fenêtre garde son propre état ; épuiser une réserve ne signifie pas que toutes les réserves du fournisseur le sont. Chaque abonnement affiche ses fenêtres réellement fournies, sous les libellés **Hebdo**, **Horaire**, **Hebdo Fable** (limite Fable de Claude) et **Hebdo Argon** (réserve Argon d’Antigravity) ; une fenêtre non fournie n’est pas affichée. Les couleurs passent du rouge à zéro à l’orange (≤ 10 % ou 2 USD), au jaune (≤ 25 % ou 5 USD), puis au vert ; les seuils monétaires concernent uniquement les crédits USD. Un relevé de plus de dix minutes, en erreur ou déconnecté est signalé « Relevé ancien » sans perdre son contraste.

## Connexions et données disponibles

| Fournisseur | Connexion requise | Ressources suivies |
| --- | --- | --- |
| OpenAI GPT | Codex installé et connecté à ChatGPT | Limites et dates de remise à zéro lues via Codex |
| Anthropic Claude | Abonnement Claude via Claude Code (bouton « Connecter Claude ») | Session de 5 h, semaine, limites par modèle (Hebdo Fable) et dates |
| xAI Grok | Compte dans Chrome ou Edge dédié | Quota hebdomadaire du dashboard ; ancien panneau Usage compatible |
| Antigravity | Antigravity App ouvert et connecté à Google | Gemini et Claude/GPT : semaine + 5 h ; **Gemini 4 Argon : semaine** |
| Z.ai | Compte Token Plan dans Chrome ou Edge dédié | Semaine et 5 h |
| Ollama | Compte connecté | Crédits mensuels inclus et réserve de crédits supplémentaires |
| OpenRouter | Clé de gestion (Management key) | Crédits achetés, consommés et restants |
| DeepSeek Platform | Clé API | Solde dans sa devise USD/CNY |
| RunInfra | Clé d’espace de travail non restreinte | Solde, réservations et dépenses de période |
| OrcaRouter | Session de compte et espace de travail | Portefeuille réel, distinct du plafond d’une clé API |

Les connecteurs lisent les ressources ; ils ne lancent aucun modèle et n’achètent rien. Lire le solde d’une clé ne prouve pas ses droits d’inférence sur tous les modèles.

### Comportement des connexions

- **Sessions conservées** : pour Ollama et OrcaRouter, la session est enregistrée dès qu’elle est validée, **avant** la première lecture. Un 429 ou une panne transitoire conserve la connexion et le dernier relevé, affiche l’erreur et laisse le cycle de 5 minutes réessayer. Seule une authentification refusée (`OLLAMA_SIGNIN`, `ORCA_AUTH`) efface la session et redemande une connexion.
- **Cooldowns 429** : lorsqu’une clé API (OpenRouter, DeepSeek, RunInfra) reçoit un 429, l’échéance est mémorisée dans l’état public (`state.apiCooldowns`, 100 entrées maximum) et respectée après redémarrage. L’erreur reste `API_RATE_LIMIT` avec l’heure de reprise.
- **Proxy Windows** : les appels API et la lecture directe Claude passent par `session.defaultSession.fetch`, donc par la configuration réseau et proxy de Windows (comme les fenêtres de l’application).
- **Lectures bornées** : GET uniquement, redirections refusées, délai de 20 s, une seule reprise sur erreur réseau ou 502/503/504, `Retry-After` respecté et plafonné. Aucune estimation n’est inventée quand un format change : le dernier relevé est conservé avec un message.
- **Diagnostic** : `npm run doctor` liste 17 contrôles. Deux seulement sont bloquants (dossier de données et chiffrement DPAPI) ; les autres sont des avertissements actionnables.

### Grok et Grok Bot

Avec **The X Subscription**, Grok, Grok Bot et les usages Cursor éligibles consomment un même pool hebdomadaire, consultable dans [grok.com/dashboard → Usage](https://grok.com/dashboard). Lasmium TOKENS-HUB suit ce pool sans fabriquer un deuxième quota Bot. L’authentification xAI commune ne fusionne pas les comptes et ne change aucun forfait.

Les anciens forfaits SuperGrok restent distincts : le panneau Settings → Usage est conservé comme parcours compatible. Lorsqu’il affiche une **Weekly Grok Bot Limit**, Lasmium TOKENS-HUB la lit séparément de la limite SuperGrok, avec sa propre date de reset ; l’épuisement de l’une ne bloque pas artificiellement l’autre. Certains comptes historiques utilisent encore le dashboard Cursor. Un compteur absent n’est jamais déduit de l’autre quota. [Parcours et limites officiels](https://docs.x.ai/x-subscription/grok-bot), [pool hebdomadaire](https://docs.x.ai/x-subscription/usage-limits).

Pour la première connexion web, se connecter dans la fenêtre Chrome ou Edge dédiée, puis **la fermer** : Lasmium TOKENS-HUB vérifie alors la session. **Vérifier maintenant** ouvre une fenêtre visible ; laisser le lecteur terminer et effectuer soi-même un éventuel contrôle humain. Une session valide sans quota lisible conserve le dernier relevé avec un avertissement.

La lecture automatique Grok fonctionne sans fenêtre Chrome ou Edge, y compris au démarrage. Si le dashboard redirige un ancien compte vers une connexion Cursor, le lecteur essaie une seule fois le panneau d’utilisation officiel Grok, sans inspecter la page externe. Seules les actions explicites **Ouvrir mon compte** et **Vérifier maintenant** peuvent ouvrir une fenêtre visible.

### Antigravity et Argon

Garder **Antigravity App** ouvert ; aucune CLI supplémentaire n’est nécessaire. L’IDE seul ne suffit pas. Le connecteur lit le service local du processus installé et distingue **trois réserves indépendantes** : Gemini, Claude/GPT et **Gemini 4 Argon** (hebdomadaire). Il ne prête à Argon aucune limite de cinq heures ni le quota d’un autre groupe.

Argon apparaît dans les cartes, le widget et les dates. Aucun score de qualité n’est inventé. [Modèles et disponibilité](https://www.antigravity.google/docs/models), [limites des forfaits](https://www.antigravity.google/docs/plans).

### Claude

Une seule connexion : ton **abonnement Claude** (Pro ou Max), via le Claude Code officiel installé sur le PC, comme Codex pour OpenAI.

**Connexions → Anthropic Claude → Connecter Claude** : si Claude Code est déjà connecté à ton compte Claude, la lecture est immédiate ; sinon Lasmium TOKENS-HUB lance la connexion officielle (`claude auth login --claudeai`), qui s’ouvre dans ton navigateur. Le forfait (Pro, Max) et le compte sont ensuite affichés. Claude Code est toujours lancé **sans** `ANTHROPIC_API_KEY` ni `CLAUDE_CODE_OAUTH_TOKEN` : une clé API ou un jeton longue durée présents dans l’environnement ne sont jamais utilisés (le jeton longue durée n’a d’ailleurs pas accès aux quotas).

Les quotas (Horaire, Hebdo, Hebdo Fable et autres limites par modèle) sont lus auprès d’Anthropic **toutes les 5 minutes** : une lecture par minute déclenchait des refus prolongés. À l’expiration, la connexion est renouvelée **en arrière-plan par Claude Code lui-même** (une courte commande silencieuse, sans fenêtre, au plus toutes les 15 minutes) : plus besoin d’ouvrir un terminal et de taper `claude`. Si cela échoue, Lasmium TOKENS-HUB renouvelle la connexion dans le fichier officiel de Claude Code, sans jamais copier de jeton vers le renderer ou les données de l’application ; toute nouvelle connexion de Claude Code est détectée en deux secondes.

La fiche n’a que trois états : **connecté** (« Vérifier maintenant »), **dernières valeurs affichées** avec l’heure du prochain essai automatique (réseau, service indisponible, lecture ou renouvellement limités par Anthropic : rien à faire), et **reconnexion nécessaire** (« Connecter Claude »). Le relevé local de Claude Desktop n’est plus utilisé. [Détails du protocole et de la protection des jetons](docs/architecture.md).

## Abonnements, dates et API

La fiche d’un abonnement ne demande que quatre informations : **forfait**, **prix** (et devise), **fréquence** (mensuel, annuel ou paiement unique) et **échéance** (prochain paiement, ou fin de la période payée pour un paiement unique). Les quotas, dates de remise à zéro et soldes sont lus automatiquement : plus de relevé ni de date de réinitialisation à saisir à la main.

- **Abonnements / mois** : mensuels + annuels ÷ 12, par devise.
- **Paiements uniques en cours** : affichés à part, jamais répartis sur les mois ; tous ceux qui ne sont pas terminés s’additionnent, quelle que soit leur durée, et chacun sort du total à sa date de fin.
- **Échéance dépassée** d’un mensuel ou d’un annuel : l’abonnement reste compté et passe « à vérifier » jusqu’à ce que la prochaine date soit indiquée. « Je n’ai plus cet abonnement » le retire des coûts et du suivi ; « Réactiver » demande une échéance future.
- **Ollama** : le forfait lu sur son site décide. Free : suivi actif compté 0 USD. Forfait payant (Pro, Max, Team) : compté avec le prix saisi. La réserve de crédits d’usage est affichée sans être comptée.

Pour une **API**, la fiche ne garde que la clé (onglet Connexion) et le **suivi des dépenses** (onglet Dépenses) : indique le montant de ta dernière recharge, puis chaque hausse du solde est comptée comme une recharge payée (« C’était un crédit offert » la retire). La vue d’ensemble affiche les **dépenses API du mois**. Le montant détecté est la hausse du solde entre deux lectures : une consommation entre-temps le sous-estime légèrement.

## Interface et accessibilité

- **Barre du haut** (comme VS Code) : marque et page à gauche, **recherche** au centre, puis **Mettre à jour** (seulement si une version est disponible), **Synchroniser**, **widget**, **thème clair/sombre** et **Réglages** ; les boutons Windows (réduire, agrandir, fermer) restent natifs.
- **Thèmes** : Clair, Sombre ou **Système (Windows)**. `system` suit `prefers-color-scheme` en direct ; les anciens inventaires gardent leur choix explicite clair ou sombre.
- **Mise en page** : navigation latérale sur desktop ; sous 900 px CSS (fenêtre réduite ou zoom), la navigation devient une **barre supérieure toujours visible**, jamais `display:none`. Lien d’évitement « Aller au contenu ».
- **Contrastes** : paires texte/fond ≥ 4,5:1 et indicateur de focus ≥ 3:1 (contrastes calculés, voir [renderer/CONTRAT-UI.md](renderer/CONTRAT-UI.md)). Aucune information portée par la couleur seule ; les niveaux sont aussi écrits.
- **Focus** : restauré après chaque rendu (navigation, filtres, fiches, synchronisation) ; sélection de texte préservée.
- **ARIA** : navigation nommée, `aria-current`, onglets de fiche `role="tab"`, jauges `role="meter"` avec valeur textuelle, zone `aria-live` pour les annonces, `role="alert"` sur les erreurs de formulaire.
- **Mouvement** : `prefers-reduced-motion` neutralise les transitions ; `forced-colors` renforce les bordures.
- **Widget** : fenêtre **360 × 660 px**, une ligne verticale par fournisseur avec toutes ses fenêtres (Claude, Antigravity), **Ollama** (limite Free + crédits achetés) et **tous les soldes API** ; icônes 18 px, chip de niveau et valeurs colorées ; les dix fournisseurs tiennent sans défilement (barre fine de 5 px seulement si la fenêtre est réduite ou la police agrandie). Une information unique reste sur la ligne d'en-tête.
- **Version** : affichée dynamiquement depuis l’IPC `app:info` (`app.getVersion()`), jamais codée en dur.

## Données et confidentialité

| Mode | Dossier |
| --- | --- |
| Portable personnel | `dist/ProvidersBar-win32-x64/data/` (dossier historique) |
| Développement | `.local/` |
| Tests isolés et captures | `test-results/` |

`LASMIUM_DATA_DIR` permet de choisir un autre dossier ; l'ancienne variable `PROVIDERSBAR_DATA_DIR` reste acceptée pour les installations existantes. Les données incluent l'inventaire, l'historique, les réglages, les profils de connexion et `credentials.json`.

- **Clés API** : chiffrées avec Electron `safeStorage` et Windows DPAPI, liées à l’utilisateur Windows. Aucune clé n’est renvoyée au renderer ni incluse dans l’export.
- **Dossier de données** : à chaque démarrage, son héritage ACL est retiré et seuls l’utilisateur courant et `SYSTEM` y ont accès (`icacls`). Un échec produit un avertissement, jamais un blocage.
- **Sessions web** : chaque fournisseur utilise un profil ou une partition isolés. Les navigateurs de connexion sont pilotés par un **pipe local** (`--remote-debugging-pipe`) ; aucun port TCP de débogage n’est ouvert par les lecteurs de comptes. Un port local n’existe qu’en **mode diagnostic explicite** (`--remote-debugging-port`), utilisé par `npm run verify:connections` et `npm run update:portable`.
- **Purge au démarrage** : fichiers `.tmp` interrompus, port de diagnostic obsolète (sauf en mode diagnostic), sauvegardes de migration au-delà des deux plus récentes, profils de navigateur temporaires orphelins.
- **Historique** : plafonné à **20 000 relevés** (≈ 7 jours à dix fournisseurs avec l’actualisation de 5 minutes) ; les plus anciens sont purgés.
- **Export** : document JSON autonome `{ app, version, exportedAt, inventory, settings, manualResets, history }`, **sans** session, sans identité et sans empreinte de clé. La restauration depuis l’export n’est pas proposée.
- **Effacer mes données** (Réglages, double confirmation) : supprime `state.json`, `credentials.json`, les profils de navigateur, les sauvegardes et les caches, puis réinitialise l’inventaire. Refusé pendant une synchronisation.
- **Télémétrie** : aucune. Lasmium TOKENS-HUB n’envoie aucune donnée d’usage à un serveur Lasmium TOKENS-HUB.

Détails complets et limites : [politique de confidentialité](PRIVACY.md) et [politique de sécurité](SECURITY.md) (modèle de menace, signalement privé, hors périmètre).

**Ne jamais distribuer le dossier `data/`, `.local/` ou les profils de navigateur.** Ils sont exclus de Git. Les erreurs conservent les dernières valeurs connues ; un format inconnu ne devient jamais une estimation de crédit ou de quota. Les devises ne sont pas converties.

## Développement et vérification

Prérequis : **Windows x64**, **Node.js ≥ 24**, npm. Chrome ou Edge est requis pour les comptes web ; Codex, Claude et Antigravity seulement pour les lecteurs concernés.

```powershell
npm ci
npm start
```

| Commande | Rôle |
| --- | --- |
| `npm test` | Suite unitaire déterministe : formats, erreurs, concurrence, migrations, chiffrement, cooldowns, sécurité et télémétrie zéro |
| `npm run test:coverage` | Même suite avec couverture de code Node (`--experimental-test-coverage`) |
| `npm run verify` | Vérification syntaxique de tous les `.cjs`/`.js` du dépôt (`node --check`) |
| `npm run lint` | Syntaxe + ESLint (`eslint.config.cjs`, règles `recommended` uniquement, aucune règle de style) |
| `npm run lint:fix` | Même contrôle, en appliquant les corrections automatiques d'ESLint |
| `npm run doctor` | Diagnostic lecture seule des prérequis (17 contrôles, `--json` disponible) |
| `npm run test:desktop` | Intégration Electron : inventaire, IPC, chiffrement, persistance, widget |
| `npm run test:resources:desktop` | Couleurs et épuisement de chaque limite dans les deux vues et les deux thèmes |
| `npm run test:claude:desktop` | Connexion Claude en un clic (Claude Code simulé), pannes, reprise, renouvellement limité |
| `npm run preview` | Aperçu en lecture seule, sans comptes ni clés, sur `http://127.0.0.1:4317` |
| `npm run package` | Construire ou actualiser le portable personnel, données conservées |
| `npm run package:release` | Construire un dossier versionné neuf, sans données personnelles |
| `npm run release:artifacts` | Créer l'archive ZIP et son empreinte SHA-256 de la release construite |
| `npm run release:verify` | Contrôler l'archive produite : extraction avec le code de l'application, fichiers indispensables, version, absence de `data/`, SHA-256 |
| `npm run update:portable` | Remplacer uniquement les ressources du portable personnel |
| `npm run verify:connections` | Lectures réelles via le portable démarré en mode diagnostic |

Les tests unitaires n’utilisent ni Electron, ni réseau, ni compte réel. Les tests Electron et les smoke tests nécessitent une session Windows interactive (DPAPI, fenêtres Chromium) ; ils utilisent des dossiers de données isolés et des réponses simulées.

**Intégration continue** : trois workflows sur `windows-latest` et Node 24. [`ci.yml`](.github/workflows/ci.yml) exécute un job **tests** obligatoire (`npm ci`, `npm run verify`, `npm run lint`, `npm test`, `npm run connectors:canary` hors ligne, `npm audit --omit=dev`) et un job **smoke-electron** *best-effort* (`continue-on-error`) pour les trois smoke tests, avec artefacts `test-results/`. Un échec du job smoke reste visible mais ne bloque pas la fusion ; la validation de release exécute les smoke tests sur une machine Windows interactive. [`release.yml`](.github/workflows/release.yml) fabrique, contrôle et dépose les fichiers d'une version sur un tag `v*` (ou à blanc, à la main) et prépare un **brouillon** de release GitHub ; [`canary-live.yml`](.github/workflows/canary-live.yml) lance le canary avec de vraies clés, à la demande. Détails dans [docs/maintenance.md](docs/maintenance.md).

### Diagnostic réel des connexions

Quitter le portable, puis le lancer avec `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1` et exécuter `npm run verify:connections`. Le script vérifie le chemin exact de l’interface, synchronise les connexions déjà suivies et écrit `test-results/connections-live.json`, sans identité, clé, cookie ni montant de portefeuille. `--include-inactive` vérifie aussi les services expirés ou en pause. Quitter puis relancer normalement pour fermer le port de diagnostic. Voir [docs/maintenance.md](docs/maintenance.md).

## Fabriquer et mettre à jour

Validation locale, puis fabrication et contrôle de l'archive :

```powershell
npm ci
npm run verify
npm test
npm run test:desktop
npm run test:resources:desktop
npm run test:claude:desktop
npm run package:release
npm run release:artifacts
npm run release:verify
npm run package:installer
```

`npm run package:installer` construit `dist/LasmiumTokensHub-Setup-<version>.exe` avec **Inno Setup 6** (`winget install JRSoftware.InnoSetup`) et ajoute son empreinte à `SHA256SUMS-<version>.txt`. L’exécutable porte l’icône et le nom de Lasmium TOKENS-HUB (ressources réécrites par `scripts/exe-resources.cjs`).

La distribution propre est créée dans `dist/LasmiumTokensHub-<version>-win32-x64/` ; la commande refuse un dossier de release déjà existant. `npm run release:artifacts` produit l'archive ZIP et `dist/SHA256SUMS-<version>.txt`, et refuse d'archiver une release contenant un dossier de données personnelles. `npm run release:verify` réextrait l'archive avec le même code que la mise à jour automatique et contrôle les fichiers indispensables, la version, l'absence de `data/` et l'empreinte SHA-256. Le portable personnel reste dans `dist/ProvidersBar-win32-x64/`, à côté de ses données.

**Publier une version** : aligner `package.json`, `CHANGELOG.md` et ce README, puis pousser un tag `vX.Y.Z` identique à la version. Le workflow [`release.yml`](.github/workflows/release.yml) rejoue les vérifications sur un runner Windows, fabrique l'archive, la contrôle, extrait les notes de la section correspondante du CHANGELOG et crée un **brouillon** de release GitHub avec le ZIP et `SHA256SUMS-<version>.txt`. Le manifeste `latest.json` de mise à jour automatique est signé et joint par le workflow si le secret `LASMIUM_UPDATER_PRIVATE_KEY` est défini ; sinon, le signer localement (`npm run updater:sign`) et le joindre à la main avant de publier la release. Un lancement manuel du workflow est un essai à blanc : mêmes fichiers, conservés 7 jours en artefact, sans toucher aux releases. Détails et portée du secret dans [docs/updates.md](docs/updates.md).

Les ressources applicatives sont préparées dans un dossier temporaire puis remplacées ensemble : les fichiers retirés des sources ne subsistent pas dans l’installation. `npm run update:portable` conserve `data/` et les sessions, ferme l’ancien processus s’il est joignable en diagnostic, puis nécessite de relancer l’application ; sinon, la quitter manuellement avant la mise à jour. Le packaging inclut les dépendances de production (`proper-lockfile`, `yauzl` et leurs dépendances) et leurs notices.

L’exécutable et l’installeur **ne sont pas signés** (aucun certificat Authenticode) ; conserver toutes les licences et notices du dossier distribué. La mise à jour automatique du portable repose sur le manifeste `latest.json` signé Ed25519 et sur l'empreinte SHA-256 de l'archive, pas sur un certificat Authenticode : SmartScreen peut demander une confirmation. La génération de la clé, la signature du manifeste et la publication sont décrites dans [docs/updates.md](docs/updates.md).

## Limites connues

- **Lectures réelles** : le service local Antigravity, le portail Ollama, le portefeuille OrcaRouter et le solde OpenRouter sont vérifiés sur une machine réelle (voir [docs/validation-0.3.4.md](docs/validation-0.3.4.md)). Les lectures authentifiées des fournisseurs (clés API, sessions web) restent à rejouer après chaque changement de service.
- Les lecteurs web (Grok, Z.ai, Ollama, bases Antigravity) dépendent des pages et services officiels, qui peuvent changer sans préavis. Un format inconnu produit une erreur, jamais une estimation.
- Claude exige Claude Code installé et connecté à un abonnement Claude ; Anthropic peut limiter temporairement la lecture ou le renouvellement (dernières valeurs affichées).
- L’export JSON n’est pas restaurable depuis l’interface ; la connexion des comptes et des clés doit être refaite.
- L’application liste les abonnements et les API ; elle ne classe plus les modèles et n’embarque plus de catalogue de prix.
- L’audit d’accessibilité est statique (structure ARIA et contrastes calculés) ; un essai avec lecteur d’écran (NVDA, Narrator) reste recommandé.
- Windows x64 uniquement ; Node.js n’est requis que pour le développement et le packaging.

## Structure et documentation

- `main.cjs` et `preload.cjs` : processus principal (cycle de vie, fenêtres, IPC, état) et pont IPC limité (27 canaux `invoke`, plus l’abonnement `state:changed`).
- `lib/` : stockage (`data-store.cjs`), sécurité des fenêtres et des données (`window-security.cjs`), export nettoyé (`privacy-export.cjs`), diagnostic (`diagnostics.cjs`), connecteurs et quotas.
- `renderer/` : shell, vues, helpers UI, thèmes et réglages ; contrat dans [renderer/CONTRAT-UI.md](renderer/CONTRAT-UI.md).
- `scripts/` et `tests/` : fabrication, diagnostic, maintenance et validation.
- [Architecture, IPC et modèles de données](docs/architecture.md)
- [Maintenance et procédures de validation](docs/maintenance.md)
- [Validation de la version 0.6.14](docs/validation-0.6.14.md) · [validation 0.6.13](docs/validation-0.6.13.md) · [validation 0.6.12](docs/validation-0.6.12.md) · [validation 0.6.11](docs/validation-0.6.11.md) · [validation 0.6.10](docs/validation-0.6.10.md) · [validation 0.6.9](docs/validation-0.6.9.md) · [validation 0.6.8](docs/validation-0.6.8.md) · [validation 0.6.7](docs/validation-0.6.7.md) · [validation 0.6.6](docs/validation-0.6.6.md) · [validation 0.6.5](docs/validation-0.6.5.md) · [validation 0.6.0](docs/validation-0.6.0.md) · [validation 0.5.0](docs/validation-0.5.0.md) · [validation 0.4.0](docs/validation-0.4.0.md) (archive) · [validation 0.3.6](docs/validation-0.3.6.md) (archive) · [validation 0.3.5](docs/validation-0.3.5.md) (archive) · [validation 0.3.4](docs/validation-0.3.4.md) (archive) · [validation 0.3.3](docs/validation-0.3.3.md) (archive) · [validation 0.3.2](docs/validation-0.3.2.md) (archive) · [validation 0.3.1](docs/validation-0.3.1.md) (archive) · [validation 0.3.0](docs/validation-0.3.0.md) (archive) · [validation 0.2.0](docs/validation-0.2.0.md) (archive)
- [Historique des versions](CHANGELOG.md)
- [Provenance des logos](assets/providers/sources.json)

Les logos appartiennent à leurs fournisseurs. La police **Inter Variable** est distribuée sous licence **SIL Open Font License 1.1** (`assets/fonts/LICENSE-Inter.txt`). Le concept de suivi dans la zone de notification est inspiré de [CodexBar](https://codexbar.app/).

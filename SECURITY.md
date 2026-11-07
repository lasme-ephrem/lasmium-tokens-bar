# Sécurité — Lasmium TOKENS-HUB

Lasmium TOKENS-HUB est une application de bureau **Windows x64** (Electron 44) qui
affiche des quotas et des soldes de services d'IA. Ce document décrit le
périmètre de sécurité, les surfaces exposées, les pratiques du projet et la
manière de signaler une vulnérabilité.

## 1. Versions prises en charge

| Version | Support sécurité |
| --- | --- |
| 0.6.x (branche `main`) | oui — dernière version publiée : 0.6.14 |
| 0.5.x et antérieures | non — mettre à jour vers la dernière version |

Les correctifs de sécurité sont livrés dans la dernière version ; il n'existe
pas de branche de maintenance séparée. Depuis 0.6.0, le portable installe
lui-même les versions suivantes par la mise à jour automatique signée (voir
§4 et [`docs/updates.md`](docs/updates.md)) ; les versions 0.6.0 à 0.6.4
doivent être mises à jour manuellement une fois, leur chaîne d'installation
étant défectueuse.

## 2. Périmètre

Couvert :

- le processus principal Electron (`main.cjs`), le pont `preload.cjs` et les
  fenêtres du tableau de bord et du widget ;
- les bibliothèques `lib/` : stockage local, chiffrement des clés, export
  nettoyé, durcissement des fenêtres, connecteurs, lecteurs de sessions ;
- les profils de navigateur et partitions de session gérés par l'application ;
- les packs de connecteurs signés (`lib/connector-packs.cjs`) et la mise à jour
  automatique signée (`lib/updater.cjs`, `lib/update-manifest.cjs`,
  `lib/zip-extract.cjs`, `lib/update-install.cjs`) ;
- la chaîne de fabrication, de signature et de livraison du portable
  (`scripts/`, CI Windows, manifeste de mise à jour).

Non couvert : voir [Hors périmètre](#6-hors-périmètre).

## 3. Modèle de menace résumé

L'application est conçue pour un poste Windows personnel, mono-utilisateur, avec
un utilisateur légitime qui contrôle sa session et son dossier de données.

**Protégé par construction**

- les clés API sont chiffrées au repos par Electron `safeStorage` / Windows
  DPAPI, liées au compte Windows ; l'application refuse d'enregistrer une clé si
  le chiffrement est indisponible ;
- le dossier de données est restreint par ACL (`icacls /inheritance:r`) à
  l'utilisateur courant et à `SYSTEM` ; un échec produit un avertissement, jamais
  un blocage ;
- le contenu distant des pages de connexion n'a ni Node.js, ni isolation de
  contexte désactivée, ni accès au pont IPC : l'IPC filtre la frame émettrice et
  l'URL exacte de l'interface ;
- les fenêtres de connexion limitent navigation, redirections et popups à une
  allowlist d'origines HTTPS (`ollama.com`, `orcarouter.ai`/`www`,
  `accounts.google.com`) ; les fenêtres de l'interface refusent navigation,
  popups et permissions ;
- les lecteurs de comptes utilisent un pipe CDP local (`--remote-debugging-pipe`)
  et n'ouvrent **aucun port TCP de débogage** ;
- l'export de données est nettoyé : aucune session, identité pseudonyme,
  empreinte de clé ou jeton ;
- la mise à jour automatique n'accepte qu'un manifeste signé Ed25519 (clé
  publique embarquée `lib/updater-public.pem`), servi en HTTPS sans redirection
  vers HTTP, et une archive dont la taille et le SHA-256 correspondent au
  manifeste ; l'extraction refuse les chemins `..`, les liens symboliques et
  tout `data/` embarqué, et l'installation ne touche jamais au dossier de
  données ;
- aucune télémétrie et aucun serveur Lasmium TOKENS-HUB : seules les lectures vers les
  services configurés par l'utilisateur et la vérification du manifeste de mise
  à jour (requête HTTPS sans donnée transmise) sortent du poste.

**Non protégé**

- un compte Windows compromis, un malware s'exécutant **sous le même compte**,
  un accès physique à une session déverrouillée : ces acteurs peuvent lire les
  fichiers de l'utilisateur et les secrets que DPAPI peut déchiffrer ;
- un navigateur personnel compromis, des extensions malveillantes ou un profil
  Chrome/Edge déjà infecté (l'application ne garantit pas la sécurité de
  l'environnement navigateur) ;
- la compromission d'un fournisseur, de ses API, de son certificat TLS ou de la
  connexion réseau (proxy d'entreprise, antivirus TLS) ;
- les composants tiers : Claude Code, Codex/Antigravity, dont les
  fichiers et sessions restent gérés par leurs éditeurs.

## 4. Surfaces sensibles et mesures associées

| Surface | Risque | Mesure |
| --- | --- | --- |
| `credentials.json` | fuite de clés API | chiffrement DPAPI, fichier séparé de l'état, jamais exporté ni renvoyé au renderer, ACL du dossier de données |
| `state.json` / historique | lecture d'habitudes d'usage | ACL du dossier, pas de secret, purge des sauvegardes et plafond de 20 000 relevés |
| Fenêtres de connexion | injection de contenu distant, hameçonnage | `sandbox`, `contextIsolation`, pas de `nodeIntegration`, `devTools:false`, allowlist d'origines, popups limités, permissions refusées |
| Renderer de l'interface | XSS par donnée de fournisseur | CSP sans `unsafe-eval` ni script inline, échappement HTML centralisé, échappement des libellés distants, `connect-src 'self'` |
| IPC (`preload.cjs` → `main.cjs`) | appel d'actions privilégiées | surface explicite de 27 méthodes `invoke` (plus l'abonnement `state:changed`), canaux littéraux, filtre frame principale + URL exacte, validation des charges utiles dans `lib/domain.cjs` (`validatePatch`, `manualSnapshot`) et des relevés dans `lib/connector-contract.cjs` |
| Sessions navigateur | vol de cookies | profils/partitions isolés par fournisseur, pipe local, pas de port TCP, `clearStorageData` à la déconnexion et à l'effacement |
| Jetons Claude Code | copie ou journalisation | lus en mémoire seulement, jamais persistés par Lasmium TOKENS-HUB, erreurs expurgées, verrous et écriture atomique du fichier officiel |
| Réseau sortant | exfiltration, mauvaise destination | liste fermée d'endpoints officiels, `redirect: 'error'`, validation stricte des réponses, aucune télémétrie |
| Export / effacement | fuite ou suppression incomplète | export nettoyé et documenté, double confirmation, refus pendant synchronisation, purge des caches et profils |
| Dossier portable | altération locale du code | ACL du dossier de données, procédures de mise à jour (manuelle ou automatique) qui remplacent les ressources ensemble ; l'exécutable n'est pas encore signé (voir §6) |
| Mise à jour automatique | manifeste ou archive altérés, téléchargement détourné | manifeste `latest.json` signé Ed25519 (clé publique embarquée), HTTPS obligatoire y compris après redirection, taille et SHA-256 vérifiés avant extraction, refus des chemins `..`, liens symboliques, doublons et `data/`, installation par script séparé après fermeture avec sauvegarde de l'ancienne version et rollback, `data/` jamais copié ni supprimé, journal `data/updates/update.log` sans secret |
| Packs de connecteurs | endpoint détourné par un pack local | packs JSON signés Ed25519 (`lib/connector-packs-public.pem`), refus d'un downgrade, d'une signature invalide, d'un endpoint HTTP ou d'un `minApp` futur ; `LASMIUM_ALLOW_UNSIGNED_PACKS=1` réservé au développement |

## 5. Pratiques du projet

- **Dépendances verrouillées** : `package-lock.json` versionné, installation par
  `npm ci` en CI ; deux dépendances de production (`proper-lockfile` pour les
  verrous du renouvellement Claude, `yauzl` pour l'extraction des archives de
  mise à jour).
  Electron est une dépendance de développement mais fournit le runtime du
  portable : sa version est vérifiée par les tests.
- **Audit** : `npm audit --omit=dev` en CI sur les dépendances de production ;
  `npm audit` complet est attendu avant chaque release, car le runtime Electron
  livré ne fait pas partie de l'audit de production.
- **CI Windows** : `ci.yml` enchaîne des jobs déterministes (syntaxe, tests
  unitaires, canary hors ligne, audit) et un job Electron best-effort nécessitant
  une session graphique interactive. `release.yml` fabrique l'archive sur un tag
  `v*`, la réextrait avec le code de l'application pour la contrôler (contenu,
  version, absence de `data/`, SHA-256) et ne crée qu'un **brouillon** de release :
  la publication reste un geste humain. Le secret facultatif
  `LASMIUM_UPDATER_PRIVATE_KEY` permet de signer `latest.json` en CI ; toute
  personne pouvant pousser un tag déclenche alors une signature, il est donc
  réservé à un dépôt dont les tags sont protégés. Sans lui, la signature reste
  locale (`npm run updater:sign`).
- **Signature des livrables** : le manifeste de mise à jour et les packs de
  connecteurs sont signés hors ligne (`npm run updater:sign`,
  `npm run connectors:sign`) ; les clés privées restent dans `.local/updater/`
  et `.local/connector-packs/` (ignorés par Git, `*.pem` exclu sauf les clés
  publiques de `lib/`) ; seules les clés publiques sont versionnées.
- **Tests de sécurité** : `tests/security.test.cjs`, `tests/window-security.test.cjs`,
  `tests/privacy-export.test.cjs` et `tests/quality.test.cjs` couvrent
  l'absence de port de débogage, l'allowlist, la CSP, l'export nettoyé, l'ACL,
  la purge conditionnelle, l'absence de télémétrie et l'absence de secrets ;
  `tests/update-manifest.test.cjs`, `tests/updater.test.cjs`,
  `tests/zip-extract.test.cjs`, `tests/update-install.test.cjs` et
  `tests/connector-packs.test.cjs` couvrent la signature, le hachage,
  l'extraction défensive, le script d'installation et les packs.
- **Revue** : les changements touchant `main.cjs`, `preload.cjs`, `lib/`, le
  renderer, la fabrication ou les dépendances sont relus avant fusion (voir
  [`docs/archive/REFONTE-CONTRATS-0.3.md`](docs/archive/REFONTE-CONTRATS-0.3.md)
  et [`docs/archive/audit-0.3/06-revue-securite-finale.md`](docs/archive/audit-0.3/06-revue-securite-finale.md)).
- **Hygiène du dépôt** : `.gitignore` exclut données, sessions, clés, `.env` et
  résultats de tests ; un test vérifie l'absence de secrets et de chemins
  personnels dans le code livré.
- **Transparence** : [`PRIVACY.md`](PRIVACY.md) décrit les données et leur
  effacement ; [`docs/architecture.md`](docs/architecture.md) décrit les flux ;
  [`docs/updates.md`](docs/updates.md) décrit la chaîne de mise à jour signée ;
  `docs/archive/audit-0.3/` contient les revues de sécurité de la refonte 0.3.

## 6. Hors périmètre

- La sécurité des services tiers (fournisseurs d'IA, Google, Ollama, OrcaRouter,
  Anthropic, OpenAI), de leurs API et de leurs certificats.
- La sécurité de Chrome, Edge, de leurs extensions et du profil personnel de
  l'utilisateur.
- Claude Code, Codex et Antigravity, y compris leurs fichiers de
  jetons et leurs mises à jour.
- Windows, les antivirus, proxys TLS d'entreprise, pilotes et périphériques.
- Un attaquant qui exécute du code avec les privilèges de l'utilisateur, obtient
  un accès physique déverrouillé ou qui obtient une copie du dossier de données
  ou de l'export.
- Les dénis de service locaux, l'ingénierie sociale et les contenus affichés par
  les fournisseurs.
- La signature Authenticode et la réputation SmartScreen du binaire portable :
  **`LasmiumTokensHub.exe` n'est pas signé** à ce jour. Le manifeste Ed25519 et
  le SHA-256 de la mise à jour automatique garantissent l'intégrité des versions
  installées par l'application, pas la provenance du premier téléchargement :
  vérifier la source (dépôt officiel, release GitHub, `SHA256SUMS-<version>.txt`)
  avant la première exécution.
- La disponibilité de l'hébergement du manifeste et des archives (GitHub
  Releases) : une compromission de l'hébergeur ne permet pas d'installer une
  archive non signée, mais peut retarder la distribution d'un correctif.

## 7. Signalement d'une vulnérabilité

Merci de signaler toute vulnérabilité **en privé** :

1. utiliser l'onglet **Security → Report a vulnerability** (Security Advisories)
   du dépôt GitHub officiel : `https://github.com/lasme-ephrem/lasmium-tokens-bar` ;
2. à défaut d'accès à cet outil, contacter le mainteneur du dépôt par un canal
   privé déjà établi ;
3. ne **pas** ouvrir d'issue publique contenant des détails exploitables, des
   données personnelles ou des secrets.

Merci d'inclure : version de Lasmium TOKENS-HUB (`app:info`), version de Windows,
description du problème, étapes de reproduction avec données fictives, impact
estimé et, si possible, preuve de concept minimale. N'incluez **jamais** de
clés API, jetons, cookies ou copies du dossier `data/`.

Le traitement se fait au mieux, sans engagement de délai contractuel : accusé de
réception, évaluation, correctif dans la dernière version si la vulnérabilité est
confirmée. Aucun programme de prime (bug bounty) n'est proposé. Les signalements
légitimes et les bonnes pratiques de divulgation responsable sont appréciés ;
les tests destructifs contre des services tiers ne sont pas autorisés.

## 8. Durcissement opérationnel recommandé

- Ne jamais partager, synchroniser, archiver sur un service distant ou joindre le
  dossier `data/`, `account-browsers/` ou un export JSON à un ticket.
- Activer le chiffrement du disque (BitLocker) et utiliser un compte Windows
  personnel protégé.
- Installer le portable dans un dossier lisible seulement par l'utilisateur ;
  éviter un partage réseau ou une clé USB non chiffrée.
- Vérifier la provenance du dossier de release (dépôt officiel,
  `SHA256SUMS-<version>.txt`) ; aucun binaire n'est signé actuellement.
- Installer les mises à jour proposées par **Réglages → Mises à jour** : seule
  une archive dont le manifeste est signé et le SHA-256 vérifié est installée,
  et `data/` n'est jamais touché. Les versions 0.6.0 à 0.6.4 doivent être mises
  à jour manuellement une fois (voir [`docs/updates.md`](docs/updates.md)).
- Pour les mainteneurs : les clés privées `.local/updater/private-key.pem`
  (mise à jour) et `.local/connector-packs/private-key.pem` (packs) sont des
  secrets à protéger — jamais versionnées, jointes à un ticket ni synchronisées ;
  en conserver une sauvegarde hors ligne. En cas de fuite suspectée, régénérer
  la paire (`npm run updater:key`, `npm run connectors:key`) et publier une
  version embarquant la nouvelle clé publique, en sachant que les installations
  existantes devront être mises à jour manuellement une fois.
- En cas de doute : **Réglages → Effacer mes données**, quitter l'application,
  supprimer le dossier de données résiduel, puis révoquer les clés API et les
  connexions de comptes auprès des fournisseurs.
- Pour le diagnostic réel, le mode `--remote-debugging-port` est un mode
  développeur explicite : ne pas laisser l'application lancée avec cette option
  et la relancer normalement après usage (la purge de démarrage retire le
  fichier de port obsolète hors mode diagnostic).

## 9. Historique

- 2026-11 (version 0.6.9) : suivi local des dépenses API (montants seulement,
  aucune donnée de paiement) ; retrait des champs saisis à la main après une
  copie complète de l'état.
- 2026-11 (version 0.6.8) : connexion Claude déléguée au Claude Code officiel,
  lancé sans clé API ni jeton longue durée ; lecture du relevé Claude Desktop
  retirée ; lecture des quotas toutes les 5 minutes.
- 2026-11 (version 0.6.7) : reprise automatique de la lecture directe Claude
  après un repli Claude Desktop, sans renouvellement de jeton supplémentaire
  entre deux essais (au plus un essai par quart d'heure, Retry-After respecté).
- 2026-11 (version 0.6.6) : correction d'un timer orphelin du navigateur de
  connexion Ollama, URL du manifeste de mise à jour vers le dépôt renommé,
  workflow de release avec contrôle de l'archive par réextraction, ESLint et
  canary hors ligne dans la CI bloquante. Détail : [`CHANGELOG.md`](CHANGELOG.md).
- 2026-11 (versions 0.6.0 à 0.6.5) : mise à jour automatique signée du portable
  (manifeste Ed25519, HTTPS obligatoire, taille et SHA-256 vérifiés, extraction
  défensive, installation après fermeture avec rollback, `data/` préservé),
  vérification 60 s après le démarrage puis toutes les 6 h, clé privée hors
  dépôt dans `.local/updater/`, dépendance de production `yauzl`. Les 0.6.1 à
  0.6.5 corrigent successivement l'extraction, le staging et le lancement du
  script ; la 0.6.5 est la première version dont l'auto-update est opérationnel
  de bout en bout. Détail : [`docs/updates.md`](docs/updates.md) et
  [`docs/validation-0.6.5.md`](docs/validation-0.6.5.md).
- 2026-11 (version 0.5.0) : packs de connecteurs JSON signés Ed25519 (refus des
  downgrades, des endpoints HTTP et des packs altérés), validation des relevés
  par contrat et disjoncteur, sauvegardes rotatives de `state.json`, bundle de
  diagnostic et journal local sans secret. Détail :
  [`docs/validation-0.5.0.md`](docs/validation-0.5.0.md) et
  [`docs/runbook-connectors.md`](docs/runbook-connectors.md).
- 2026-11 (version 0.3.0) : suppression de tout port CDP TCP pour les lecteurs de
  comptes (`--remote-debugging-pipe`), allowlist d'origines pour les fenêtres de
  connexion, ACL du dossier de données, export nettoyé, effacement des données,
  `devTools:false`, CSP et échappement durcis, Electron 44.10.2 (audit des
  dépendances sans vulnérabilité connue). Détail et résiduels :
  [`docs/archive/audit-0.3/06-revue-securite-finale.md`](docs/archive/audit-0.3/06-revue-securite-finale.md).

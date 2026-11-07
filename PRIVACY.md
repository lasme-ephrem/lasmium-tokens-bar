# Confidentialité — Lasmium TOKENS-HUB

Ce document décrit le comportement de la version **0.6.14** ; la version
installée est affichée dans les réglages de l'application.

Lasmium TOKENS-HUB est une application **locale pour Windows x64**. Elle ne dispose
d'aucun serveur, d'aucun compte Lasmium TOKENS-HUB et d'aucune télémétrie : les données
décrites ici restent sur l'appareil de l'utilisateur, dans le dossier de données
de l'application.

Ce document décrit ce que l'application traite réellement, où ces données sont
stockées, comment elles sont protégées, et comment les consulter ou les effacer.
Il ne constitue pas une certification de conformité juridique (voir
[Limites et transparence](#limites-et-transparence)).

## 1. Données traitées

| Donnée | Contenu | Origine |
| --- | --- | --- |
| Inventaire des services | Nom, type (abonnement ou API), tarif, devise, périodicité, date d'échéance, notes libres, favori, état actif/expiré | Saisie de l'utilisateur, complétée par les migrations de l'application |
| Historique des relevés | Jusqu'à **20 000 relevés** (identifiant, fournisseur, horodatage, soldes par devise, pourcentages de quota, dates de remise à zéro) | Lectures fournisseurs et relevés manuels |
| Réglages | Actualisation automatique, notifications, seuil de solde bas, thème clair/sombre/système | Saisie de l'utilisateur |
| Santé des connecteurs | Par fournisseur : dernier succès, dernier échec, compteur d'échecs, code et message d'erreur, prochaine tentative | Résultat des lectures fournisseurs |
| Clés API | Clés OpenRouter, DeepSeek et RunInfra, **chiffrées** (voir §3) | Saisie de l'utilisateur |
| Sessions de connexion aux comptes | Profils Chrome/Edge dédiés et partitions Electron (`persist:ollama-account`, `persist:orcarouter-account`) : cookies de session, stockage local des portails fournisseurs | Connexion de l'utilisateur sur les sites officiels |
| Identifiants de compte pseudonymes | Pour OpenAI : empreinte SHA-256 de l'adresse e-mail du compte Codex (jamais l'adresse en clair). Pour OrcaRouter : identifiants **numériques** de compte et d'espace de travail. | Réponses des services officiels |
| Cooldowns API | Empreintes SHA-256 de clés API et échéance de reprise après une réponse HTTP 429 (plafond 100 entrées) | Réponses des fournisseurs |
| Jetons Claude Code | Jetons OAuth lus **en mémoire** depuis le fichier officiel de Claude Code, jamais copiés dans Lasmium TOKENS-HUB | Fichier local `~/.claude/.credentials.json` |
| Journal local | Échecs de lecture (code et message), sauvegardes d'état, démarrages, disponibilité d'une mise à jour ; **sans clé, jeton, solde ni chemin absolu** | Fonctionnement de l'application |
| Mise à jour automatique | Version disponible, archive téléchargée et journal du script d'installation (`updates/update.log`) | Manifeste et archive de la release officielle |

Aucune conversation, aucun contenu de prompt, aucun mot de passe et aucun
message ne sont lus ou conservés. Les lecteurs de comptes n'extraient que des
pourcentages, des soldes, des libellés de limite bornés et des dates.

## 2. Où sont stockées les données

| Mode d'installation | Dossier de données |
| --- | --- |
| Portable personnel | `dist/ProvidersBar-win32-x64/data/` (nom historique conservé, à côté de l'exécutable) |
| Développement | `.local/` |
| Choix explicite | dossier indiqué par la variable d'environnement `LASMIUM_DATA_DIR` (l'ancienne `PROVIDERSBAR_DATA_DIR` reste acceptée) |

Ce dossier contient notamment :

- `state.json` : inventaire, réglages, santé des connecteurs, cooldowns et historique ;
- `credentials.json` : clés API chiffrées (aucune clé en clair) ;
- `backups/` : copies de `state.json` (au plus une toutes les 6 h, les **cinq plus
  récentes** conservées) ; elles contiennent donc les mêmes données que l'état ;
- `logs/lasmium.log` : journal rotatif (256 Ko, trois fichiers), sans secret ;
- `connector-packs/` : packs de connecteurs signés ajoutés localement (facultatif) ;
- `updates/` : archives de mise à jour téléchargées, dossier de préparation et
  journal `update.log` du script d'installation ;
- `account-browsers/<fournisseur>/` : profils Chrome/Edge dédiés aux comptes web ;
- `Partitions/` : sessions Electron persistantes (Ollama, OrcaRouter) ;
- `temporary-account-browsers/` : profils temporaires de lecture, purgés au démarrage ;
- `state.before-*.json` : sauvegardes de migration, limitées aux **deux plus récentes** par la purge de démarrage.

`state.json` et l'historique **ne sont pas chiffrés** : leur protection repose sur
le contrôle d'accès du système de fichiers (voir §3) et sur la session Windows.
Il ne faut jamais partager ni synchroniser ce dossier.

## 3. Protection des données locales

- **Clés API** : chiffrées par Electron `safeStorage`, qui s'appuie sur Windows
  DPAPI et lie le chiffrement au compte Windows courant. Les données chiffrées
  sont inutilisables sur un autre compte Windows ou un autre appareil. Si le
  chiffrement Windows est indisponible, l'application **refuse d'enregistrer**
  la clé au lieu de la stocker en clair. La clé n'est jamais renvoyée au
  renderer, jamais journalisée et jamais incluse dans l'export.
- **Dossier de données** : à chaque démarrage, l'application retire l'héritage
  ACL du dossier et n'y accorde l'accès complet qu'à l'utilisateur courant et à
  `SYSTEM` (`icacls /inheritance:r`). Un échec de cette étape produit un
  avertissement mais ne bloque pas l'application : dans ce cas, seules les
  permissions héritées du dossier parent protègent les fichiers. Le dossier ne
  doit donc pas être placé sur un partage réseau, une clé USB non chiffrée ou un
  répertoire accessible à d'autres comptes.
- **Sessions navigateur** : chaque fournisseur dispose d'un profil ou d'une
  partition isolés. Les cookies sont gérés et chiffrés par Windows pour le
  compte courant. Les lecteurs de comptes communiquent avec le navigateur par un
  **pipe local** (`--remote-debugging-pipe`) : aucun port TCP de débogage n'est
  ouvert pour lire une session.
- **Suppression locale** : la déconnexion d'un fournisseur efface sa session
  (profil ou partition) et sa clé API ; les sessions Ollama et OrcaRouter sont
  effacées via `clearStorageData`.

## 3 ter. Lancement au démarrage

Si tu l'actives (installeur ou Réglages), Windows enregistre une valeur sous
`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` qui
lance l'application avec `--hidden`. Aucune autre donnée n'est écrite dans le
registre ; la désinstallation retire cette valeur.

## 3 bis. Suivi des dépenses API

Si tu démarres le suivi des dépenses d'un accès API, `state.json` conserve le
montant de départ, sa date, le dernier solde lu et la liste des recharges
détectées (date, montant, crédit offert ou non). Ces montants restent sur
l'appareil, comme les soldes, et sont inclus dans l'export de tes données.

## 4. Jetons Claude Code

La lecture des quotas Claude est activée par le bouton « Connecter Claude ».
Elle utilise la connexion OAuth de Claude Code à ton abonnement Claude ; si
elle manque, Lasmium TOKENS-HUB lance la connexion officielle
(`claude auth login --claudeai`) dans le navigateur. Seul le statut de Claude
Code (connecté, forfait, adresse e-mail) est lu ; la clé API et le jeton longue
durée éventuellement présents dans l'environnement ne lui sont pas transmis :

- les jetons sont lus depuis `~/.claude/.credentials.json` et restent en mémoire
  du processus principal ; ils ne sont **jamais** copiés dans les données
  Lasmium TOKENS-HUB, jamais envoyés au renderer et jamais exportés ;
- à l'expiration, la connexion est d'abord renouvelée par Claude Code lui-même :
  Lasmium lance `claude -p` en mode silencieux (modèle Haiku, aucun outil, aucune
  session enregistrée) avec une invite fixe, « Réponds uniquement : OK », qui ne
  contient aucune donnée personnelle et compte comme une très petite requête sur
  ton abonnement ; au plus une fois toutes les 15 minutes ;
- sinon, le renouvellement de la connexion réécrit ce même fichier officiel, avec les
  verrous et l'écriture atomique de Claude Code, et conserve les autres champs ;
- le forfait, l'adresse e-mail du compte et les délais de reprise sont
  enregistrés dans `state.json` (code d'erreur et horodatage), sans jeton.

L'effacement des données de Lasmium TOKENS-HUB ne supprime **pas** ce fichier : il
appartient à Claude Code. Une révocation ou une déconnexion dans Claude Code
reste la manière de supprimer cette connexion.

De la même façon, OpenAI s'appuie sur la session Codex installée sur le poste
(gérée par Codex). Le relevé local de Claude Desktop n'est plus lu.
Ces composants restent sous la responsabilité de leurs éditeurs.

## 5. Réseau et absence de télémétrie

Lasmium TOKENS-HUB n'envoie aucune donnée d'usage, de diagnostic ou de performance à
un serveur Lasmium TOKENS-HUB. Il n'y a ni analytics, ni crash reporting, ni publicité.

Les seules connexions sortantes servent à lire les informations demandées par
l'utilisateur, vers les services officiels qu'il a lui-même configurés :

- `openrouter.ai`, `api.deepseek.com`, `api.runinfra.ai` (soldes par clé API) ;
- `platform.claude.com` et `api.anthropic.com` (renouvellement OAuth et quotas Claude) ;
- `chatgpt.com` / Codex local pour OpenAI ;
- `claude.ai`, `grok.com`, `z.ai` (pages d'utilisation dans Chrome/Edge) ;
- `ollama.com` et `www.orcarouter.ai` (sessions de compte) ;
- services locaux en boucle locale : service Antigravity sur `127.0.0.1` (port
  du processus installé vérifié) et Codex `app-server` local ;
- `github.com` (manifeste `latest.json` et archive ZIP de la release officielle,
  uniquement pour la mise à jour automatique).

Les écritures sont temporaires ou mises en cache par Windows/Chromium comme tout
navigateur. Aucun proxy particulier n'est utilisé : les réglages réseau de
Windows s'appliquent.

**Mise à jour automatique.** Dans le portable, l'application envoie une requête
HTTPS vers le manifeste `latest.json` de la release GitHub 60 secondes après le
démarrage, puis **toutes les 6 heures**, ainsi qu'à la demande depuis
**Réglages → Mises à jour**. Cette requête ne transmet **aucune donnée** : ni
identifiant, ni inventaire, ni version installée (la comparaison de version se
fait localement). Le manifeste est vérifié par signature Ed25519 avant toute
utilisation ; l'archive n'est téléchargée que sur demande d'installation et
son SHA-256 est contrôlé. Les étapes et erreurs du script d'installation sont
consignées dans `data/updates/update.log`, sans secret ni donnée personnelle.
Le dossier `data/` n'est jamais copié, remplacé ni supprimé par une mise à
jour. En développement, aucune vérification n'a lieu sauf si
`LASMIUM_UPDATE_MANIFEST_URL` est défini. Voir
[`docs/updates.md`](docs/updates.md).

## 6. Export des données

L'action **Exporter mes données** produit un fichier JSON choisi par
l'utilisateur, au format :

```json
{ "app": "Lasmium TOKENS-HUB", "version": "…", "exportedAt": "…",
  "inventory": [], "settings": {},
  "manualResets": {}, "history": [] }
```

L'export est **nettoyé** : il ne contient ni session de compte, ni identifiant de
compte, ni identité pseudonyme, ni empreinte de clé API, ni jeton. Il peut en
revanche contenir l'historique d'usage, les notes libres et les tarifs saisis :
c'est un fichier **en clair**, à conserver et à partager avec précaution. La
restauration depuis l'interface n'est pas proposée.

## 7. Effacement des données

**Réglages → Effacer mes données** demande une double confirmation (second clic
dans les 10 secondes). L'effacement est refusé pendant une synchronisation. Il
supprime `state.json`, `credentials.json`, les profils de navigateur dédiés, les
profils temporaires, les sauvegardes de migration et les caches Chromium
(`Cache`, `Network`, `Local Storage`, `Partitions`, etc.), puis réinitialise
l'inventaire de départ.

Ce qui n'est **pas** effacé par cette action :

- les sous-dossiers `backups/` (copies de `state.json`), `logs/`, `updates/` et
  `connector-packs/` du dossier de données : les supprimer manuellement avec le
  dossier de données pour une remise à zéro complète ;
- `~/.claude/.credentials.json` (fichier de Claude Code) ;
- la session Codex et l'installation de Codex ;
- les fichiers système, l'historique Windows et les sauvegardes externes
  éventuelles (par exemple une copie du dossier `data/` faite par l'utilisateur).

Pour une remise à zéro complète, effacer les données depuis l'interface, quitter
l'application, puis supprimer le dossier de données s'il subsiste. Une
désinstallation manuelle (suppression du dossier portable) n'efface pas
forcément ce dossier de données : il doit être supprimé explicitement.

## 8. Durées de conservation

| Donnée | Conservation |
| --- | --- |
| Historique | 20 000 relevés maximum ; les plus anciens sont purgés à l'écriture et au chargement |
| Sauvegardes de migration | 2 plus récentes, les autres purgées au démarrage |
| Sauvegardes rotatives (`backups/`) | 5 plus récentes, au plus une toutes les 6 h |
| Journal local (`logs/`) | 3 fichiers de 256 Ko maximum, les plus anciens écrasés |
| Mises à jour (`updates/`) | Archive et dossier de préparation conservés par version jusqu'à suppression manuelle ; une seule sauvegarde de l'ancienne application est gardée à côté de l'exécutable |
| Cooldowns API | Entrées expirées purgées au démarrage et avant chaque lecture ; plafond 100 |
| Profils temporaires de lecture | Purgés au démarrage et à la fermeture normale du lecteur |
| Sessions de compte et clés API | Jusqu'à déconnexion ou effacement des données |

## 9. Droits et contrôle de l'utilisateur

- **Accès** : toutes les données sont visibles dans l'application et
  exportables en JSON.
- **Rectification** : les fiches de service, les réglages et les dates de
  réinitialisation sont modifiables dans l'interface.
- **Effacement** : action dédiée dans les réglages (voir §7).
- **Portabilité** : export JSON autonome, lisible par un autre outil.
- **Refus** : aucune connexion de compte ni saisie de clé n'est obligatoire ;
  l'application reste utilisable avec des relevés manuels.
- **Transparence** : ce document, [`SECURITY.md`](SECURITY.md),
  [`docs/architecture.md`](docs/architecture.md) et
  [`docs/updates.md`](docs/updates.md) décrivent les flux réels.

## 10. Limites et transparence

- L'identité des comptes (e-mail, jetons Google, mots de passe) est gérée par les
  **fournisseurs** et par leurs pages officielles. Lasmium TOKENS-HUB ne lit ni ne
  stocke ces éléments ; il enregistre uniquement les pourcentages et soldes
  affichés sur les pages d'utilisation.
- Les données affichées peuvent être incomplètes ou retardées par le fournisseur :
  l'application conserve alors le dernier relevé et l'indique, sans estimation
  silencieuse.
- `state.json`, l'historique et l'export **ne sont pas chiffrés au repos** : la
  confidentialité de ces fichiers dépend du compte Windows, des ACL du dossier et
  du chiffrement du disque. Activer BitLocker et réserver le dossier `data/` à
  l'utilisateur sont recommandés.
- La protection contre un logiciel malveillant exécuté **sous le même compte
  Windows** est limitée par construction : un tel programme peut lire les
  fichiers de l'utilisateur et les secrets déchiffrables par DPAPI. Voir
  [`SECURITY.md`](SECURITY.md).
- Ce document décrit le comportement de l'application ; il **ne constitue pas une
  certification de conformité** (RGPD ou autre) et ne crée pas d'engagement
  contractuel. Pour un usage professionnel soumis à des obligations particulières,
  faire valider le déploiement par le responsable conformité compétent.

## 11. Signalement

Pour signaler un problème de sécurité (fuite de données, faille, comportement
inattendu), suivre la procédure de [`SECURITY.md`](SECURITY.md) — de préférence
un signalement privé, sans publier de détails exploitables.

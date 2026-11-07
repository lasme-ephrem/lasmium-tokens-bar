# Canary live et mises à jour signées

## 1. Canary live : où mettre les clés

Les clés de test ne sont **jamais** lues par l'application et ne sont pas versionnées.
Le fichier local est déjà créé :

`.local/canary.env`

Renseigne uniquement des clés dédiées, en lecture seule et sans solde utile :

```dotenv
LASMIUM_CANARY_OPENROUTER_KEY=sk-or-...
LASMIUM_CANARY_DEEPSEEK_KEY=sk-...
LASMIUM_CANARY_RUNINFRA_KEY=...
```

Puis lance :

```powershell
npm run connectors:canary:live
```

Le script charge `.local/canary.env` sans écraser les variables déjà présentes dans
PowerShell ou en CI. Il refuse de prétendre avoir testé quelque chose si aucune clé
n'est fournie (code de sortie `2`). OrcaRouter n'a pas de clé API : il est ignoré.

Pour la CI, utilise les secrets `LASMIUM_CANARY_OPENROUTER_KEY`,
`LASMIUM_CANARY_DEEPSEEK_KEY` et `LASMIUM_CANARY_RUNINFRA_KEY`, avec un déclenchement
manuel ou planifié. Ne les expose jamais dans une PR provenant d'un fork.

## 2. Mise à jour automatique du portable

### Principe

1. L'application interroge un manifeste HTTPS (`latest.json`).
2. Le manifeste est vérifié avec la clé publique Ed25519 **de mise à jour**.
3. Le ZIP est téléchargé, son SHA-256 et sa taille sont vérifiés.
4. Le ZIP est extrait avec refus des chemins `..`, des liens symboliques et des
   archives contenant `data/`.
5. Un script PowerShell séparé attend la fermeture de l'application, sauvegarde
   `resources/app` et l'exécutable, copie la nouvelle version, puis relance.
6. `data/` n'est jamais copié, remplacé ni supprimé.

Une seule sauvegarde de secours est conservée. En cas d'échec de copie, l'ancienne
version est restaurée. Le journal est écrit dans `data/updates/update.log`.

### Clés

- Clé privée : `.local/updater/private-key.pem` — **ne jamais versionner**, sauvegarde
  hors ligne recommandée. Sans elle, aucune nouvelle mise à jour ne peut être signée.
- Clé publique : `lib/updater-public.pem` — versionnée, embarquée dans l'application.

Pour régénérer une paire (uniquement si tu acceptes de casser les mises à jour des
versions déjà installées) :

```powershell
npm run updater:key
```

La commande refuse d'écraser une clé existante.

### Construire et signer une version

```powershell
npm run package:release
npm run release:artifacts
npm run release:verify
npm run updater:sign -- --version 0.6.14 --notes "Corrections et mise à jour automatique"
```

`npm run release:verify` extrait l'archive dans un dossier temporaire avec le même
`extractZip` que l'application, vérifie les fichiers indispensables, la version de
`resources/app/package.json`, l'absence de tout dossier `data/` et la concordance
du SHA-256 avec `SHA256SUMS-0.6.14.txt`.

Le manifeste est écrit dans `dist/latest.json`. Sans `--url`, l'URL GitHub Releases
du dépôt `lasme-ephrem/lasmium-tokens-bar` est utilisée. `--notes-file chemin`
remplace `--notes` pour des notes multilignes (par exemple la section du CHANGELOG
produite par `node scripts/release-notes.cjs`).

Pour un autre hébergement :

```powershell
npm run updater:sign -- --version 0.6.14 --url "https://mon-domaine.example/LasmiumTokensHub-0.6.14-win32-x64.zip" --out dist/latest.json
```

### Publier

Le workflow [`release.yml`](../.github/workflows/release.yml) remplace la
fabrication et le dépôt manuels des fichiers sur GitHub Releases :

1. vérifier que `package.json`, `CHANGELOG.md` et `README.md` annoncent la version ;
2. créer et pousser le tag `v0.6.14`, identique à la version de `package.json`
   (sinon le workflow échoue explicitement) ;
3. le workflow rejoue `npm run verify`, `npm run lint` et `npm test`, fabrique
   `dist/LasmiumTokensHub-0.6.14-win32-x64.zip` et `SHA256SUMS-0.6.14.txt`, contrôle
   l'archive (`npm run release:verify`), extrait les notes de la section `## 0.6.14`
   du CHANGELOG, lance un smoke best-effort sur le binaire construit, puis crée la
   release GitHub en **brouillon** avec ces fichiers (ou complète la release du tag
   si elle existe déjà) ;
4. `latest.json` : signé et joint par le workflow si le secret
   `LASMIUM_UPDATER_PRIVATE_KEY` est défini ; sinon, une notice le rappelle et il faut
   le signer localement (`npm run updater:sign -- --version 0.6.14 --notes "..."`) puis
   le joindre à la main **sous le nom exact `latest.json`** ;
5. relire le brouillon et publier la release. Les applications installées ne voient
   la mise à jour qu'une fois la release publiée
   (`releases/latest/download/latest.json`).

Un lancement manuel du workflow (**Run workflow**) est un essai à blanc : mêmes
vérifications et mêmes fichiers, conservés 7 jours en artefact de workflow, sans
toucher aux releases.

#### Secret `LASMIUM_UPDATER_PRIVATE_KEY` (facultatif)

Contenu PEM de `.local/updater/private-key.pem`, déclaré dans les secrets Actions
du dépôt. Le workflow l'écrit dans un fichier temporaire du runner, hors du dépôt
et de `dist/`, le passe à `npm run updater:sign -- --key ...` puis le supprime ; il
n'apparaît ni dans les journaux ni dans les artefacts.

Portée : toute personne capable de pousser un tag `v*` déclenche alors une
signature valide, reconnue par toutes les applications installées. Ne définir ce
secret que sur un dépôt dont les tags et `main` sont protégés et dont les
mainteneurs sont de confiance ; à défaut, garder la signature locale. Une clé
compromise impose de régénérer la paire (voir « Clés »), ce qui casse les mises à
jour automatiques des versions déjà installées.

Sur un serveur statique, dépose le ZIP et `latest.json`, puis configure
`LASMIUM_UPDATE_MANIFEST_URL` avec l'URL HTTPS du manifeste. En production, une
variable d'environnement utilisateur n'est pas pratique : modifie la constante
`DEFAULT_UPDATE_MANIFEST_URL` dans `main.cjs` ou garde GitHub Releases.

### Tester sans publier

Les tests unitaires vérifient la signature, le hash, l'extraction et le script
d'installation. Ils tournent sur toute plate-forme : les archives de test sont
fabriquées en JavaScript pur (`tests/helpers/zip-writer.cjs`), la plate-forme
Windows et le lancement du script sont injectés dans `createUpdater`. Seule
l'exécution réelle du script PowerShell reste réservée à Windows ; son analyse
syntaxique est vérifiée partout où `powershell.exe` ou `pwsh` est disponible.
Pour un essai complet :

- utilise une release GitHub **draft** ou un petit serveur HTTPS ;
- lance l'application portable construit pour la version N-1 ;
- vérifie le bandeau **Réglages → Mises à jour** ;
- contrôle que `data/state.json` et `data/backups/` ont les mêmes tailles avant/après.

En développement, `LASMIUM_UPDATE_MANIFEST_URL` active la vérification, mais
l'installation reste bloquée sauf avec `LASMIUM_ALLOW_DEV_UPDATES=1` (à réserver aux
essais jetables, jamais au dossier de données réel).

### Limites

- Windows x64 uniquement.
- Une connexion HTTPS est obligatoire.
- Les versions 0.6.0 à 0.6.4 contenaient des défauts d’extraction, de staging ou de lancement du script (entrée racine `./`, fichiers `.asar`, staging sous `data/updates`, démarrage du script) ; la 0.6.5 les corrige. Les clients 0.6.0 à 0.6.4 doivent être mis à jour manuellement une fois.
- La publication et le certificat Authenticode restent des choix externes : le
  manifeste Ed25519 garantit l'intégrité, pas la réputation SmartScreen.
- Conserve une copie du ZIP et de la clé privée : la sauvegarde de secours locale
  n'est pas un archive de release.

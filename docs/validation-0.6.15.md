# Validation 0.6.15

Date : 8 novembre 2026
Commit : `cb344b6` — tag `v0.6.15`
Release : https://github.com/lasme-ephrem/lasmium-tokens-bar/releases/tag/v0.6.15

Version corrective : la connexion OrcaRouter se fait dans Chrome ou Edge, comme
pour Ollama.

## Origine

L'utilisateur signale que la fenêtre de connexion OrcaRouter « n'est pas la même
que pour les autres », plante, se ferme seule ou ne laisse pas cliquer sur un
lien. Contrôles :

- page de connexion réelle : GitHub, Google, Microsoft, lien e-mail et clé
  d'accès. La fenêtre intégrée n'autorisait que `orcarouter.ai`, `ollama.com` et
  `accounts.google.com` : GitHub et Microsoft étaient bloqués sans message, la
  clé d'accès refusée (permissions désactivées), le lien e-mail ouvert dans un
  autre navigateur ; Google refuse les fenêtres intégrées ;
- toute erreur non liée à l'authentification (429, panne) refermait la fenêtre
  pendant la connexion.

## Correction

- `account-browser.cjs` : `openOrcaBrowser` ouvre Chrome ou Edge (profil
  `account-browsers/orcarouter`, sans pipe de débogage) sur `/console`. Après la
  fermeture, un lecteur sans fenêtre lit `localStorage.user.id`,
  `active_workspace_id` et les cookies de `orcarouter.ai`/`www` uniquement.
- Fin de connexion : sortie du processus **et** libération du profil
  (`lockfile`) ; Chrome rend la main en 61 ms quand le profil est déjà ouvert
  (mesuré). Sortie en moins de 3 s sans jamais ouvrir le profil :
  `BROWSER_FAILED`, message explicite. Même règle pour Ollama.
- `provider-flows.cjs` : cookies copiés dans `persist:orcarouter-account` avant
  `fetchWallet` ; session enregistrée conservée si aucune nouvelle session n'est
  détectée ; fenêtre intégrée en recours sans Chrome ni Edge, qui ne se ferme
  plus sur une erreur passagère. Déconnexion : profil dédié supprimé.

## Diagnostic d'un premier essai manqué

Le premier test manuel (version de développement) affichait « Chrome ou Edge
s'est fermé dès son ouverture ». Mesure : Chrome lancé par un Electron situé dans
le dossier du dépôt plantait au démarrage (`0x80000003`) dans toutes les
variantes, alors que le même Electron copié dans `%LOCALAPPDATA%` le lançait
correctement, avec ou sans bac à sable. Les droits du dossier de travail
(groupes de bac à sable, étiquette d'intégrité basse) en sont la cause ;
l'application installée lance déjà Chrome pour Grok et Ollama. Les tests suivants
ont donc été faits sur l'application packagée, hors de ce dossier.

## Vérifications

- Application packagée lancée hors du dépôt, vrai Chrome, vrai site : Chrome
  ouvert à 2, 4 et 6 s, message d'attente sans erreur ; fermeture sans compte →
  « Aucune session OrcaRouter détectée ».
- Code du site : `localStorage.setItem("user", …)` et `active_workspace_id` à la
  connexion, effacés à la déconnexion ; en-tête `New-Api-User`, session par
  cookie. API sans session : `/api/user/self` HTTP 401 → `ORCA_AUTH` ;
  `/api/status` : `quota_per_unit` 500000.
- **Constaté chez l'utilisateur** sur la version packagée de test : connexion
  OrcaRouter réussie avec son compte (« ça fonctionne nickel »).
- `npm run lint` (0 erreur), `npm test` (**379/379**), smokes `test:desktop`,
  `test:claude:desktop`, `test:resources:desktop` **PASS**.

## Artefacts publiés

| Fichier | SHA-256 |
| --- | --- |
| `LasmiumTokensHub-0.6.15-win32-x64.zip` | `51a218ef21d467230a403d4b069145e5a3c66efb3c72a8be39a9d37fa01ec427` |
| `LasmiumTokensHub-Setup-0.6.15.exe` | `ec2e19a2d8f8bb26bcc460a987612359e7aba0d6a1fd758cd18e11c649187212` |

- Empreintes identiques à `SHA256SUMS-0.6.15.txt` après téléchargement du brouillon.
- `latest.json` signé localement ; signature valide avec `lib/updater-public.pem`
  et plus récent pour des clients 0.6.14 et 0.6.13 ; ZIP et installeur
  accessibles (HTTP 200).
- Workflow Release vert ; CI du commit de la version verte.

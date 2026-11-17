# Validation 0.6.18

Date : 18 novembre 2026
Commit : `8c21801` — tag `v0.6.18`
Release : https://github.com/lasme-ephrem/lasmium-tokens-bar/releases/tag/v0.6.18

Version corrective : le bon message après « Connecter Claude ».

## Origine

Le smoke `test:claude:desktop` échouait de façon intermittente (constaté 2 fois
sur 3 sur le code 0.6.16, avant le retrait d'OrcaRouter) : la notification
attendue « Claude connecté à ton abonnement » était remplacée par « Relevé
Claude récupéré. ». La réponse de l'action de connexion (`enableClaudeLive`) et
la diffusion d'état (`receiveState`, notification « connecté » quand
`accountConnection.status` passe à `connected`) n'arrivent pas toujours dans le
même ordre ; la dernière notification affichée l'emportait.

## Correction

`renderer/app.js` : `holdConnectionToast(id)` au début d'une action de
connexion (`claude-enable-live`, `account-open`, `account-verify`),
`releaseConnectionToast(id)` à sa fin (délai de 3 s). Pendant ce délai,
`receiveState` n'affiche pas sa propre notification « connecté » pour ce
fournisseur. Les connexions détectées en arrière-plan gardent leur notification.

## Vérifications

- `test:claude:desktop` : **8 réussites sur 8** consécutives (1 sur 3 avant).
- `npm run lint` (0 erreur), `npm test` (**365/365**), smokes `test:desktop` et
  `test:resources:desktop` **PASS**.

## Artefacts publiés

| Fichier | SHA-256 |
| --- | --- |
| `LasmiumTokensHub-0.6.18-win32-x64.zip` | `dae5e3f3dfe5ae67be91c4b8f98408c5c6ff574615622ac269bc4a391b3f36c5` |
| `LasmiumTokensHub-Setup-0.6.18.exe` | `e8499a76a848c1f6326d91dfb30b3a973f71c5771bdc5ce02b35a37f2861ef46` |

- Empreintes identiques à `SHA256SUMS-0.6.18.txt` après téléchargement du brouillon.
- `latest.json` signé localement ; signature valide avec `lib/updater-public.pem`
  et plus récent pour des clients 0.6.17 et 0.6.16 ; ZIP et installeur
  accessibles (HTTP 200).
- Workflow Release vert ; CI du commit de la version verte.

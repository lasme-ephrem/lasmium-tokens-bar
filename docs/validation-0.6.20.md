# Validation 0.6.20

Date : 24 novembre 2026
Commit : `d4ff385` — tag `v0.6.20`
Release : https://github.com/lasme-ephrem/lasmium-tokens-bar/releases/tag/v0.6.20

Version corrective : plus de fenêtre PowerShell après une mise à jour.

## Origine

Après chaque mise à jour, une fenêtre Windows Terminal titrée
`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "…\install-0.6.19.ps1"`
restait ouverte et affichait le journal de démarrage de Lasmium ; la fermer
arrêtait l'application. Constat sur le PC de l'utilisateur : Lasmium relancée
sans parent vivant (script terminé), fenêtre Windows Terminal toujours ouverte.
Le script était lancé via `cmd.exe` détaché (`DETACHED_PROCESS`) : PowerShell,
application console, recevait une nouvelle console (Windows Terminal par
défaut) ; Lasmium, relancée par `Start-Process`, s'y rattachait (comportement
Electron par défaut).

## Correction

- `lib/updater.cjs` : `powershell.exe` lancé directement, détaché,
  `-WindowStyle Hidden`, sans console ; si l'accusé n'arrive pas en 5 s, le
  processus est arrêté et le shell natif (fenêtre masquée) sert de recours
  (10 s) ; sinon l'erreur « n'a pas démarré » est signalée, sans processus
  restant.
- `lib/update-install.cjs` : `ELECTRON_NO_ATTACH_CONSOLE=1` avant la relance et
  avant la relance de secours.
- Limite : la correction vaut pour les mises à jour lancées depuis la 0.6.20 ;
  le passage 0.6.19 → 0.6.20 utilise encore l'ancien lanceur.

## Vérifications

- Installation réelle, application packagée hors du dépôt : le vrai
  `createUpdater` installe l'archive 0.6.19 signée publiée (réseau remplacé par
  les fichiers locaux, lancement du script réel). Version installée 0.6.19,
  application relancée, parent terminé, **0** fenêtre de console du script,
  **0** PowerShell restant. Copie supprimée.
- `npm run lint` (0 erreur), `npm test` (**369/369**, dont un test du recours
  par le shell et de l'arrêt des lancements sans accusé), smokes `test:desktop`,
  `test:claude:desktop`, `test:resources:desktop` **PASS**.

## Artefacts publiés

| Fichier | SHA-256 |
| --- | --- |
| `LasmiumTokensHub-0.6.20-win32-x64.zip` | `e1e2ee4c6b94fde87503094f1ebf90085bd75d73e2e3ea2e52400227d984c428` |
| `LasmiumTokensHub-Setup-0.6.20.exe` | `581feb30850a14c5ad8735d37ecc8296ed65b8e5fae9940c54abf74919b674c1` |

- Empreintes identiques à `SHA256SUMS-0.6.20.txt` après téléchargement du brouillon.
- `latest.json` signé localement ; signature valide avec `lib/updater-public.pem`
  et plus récent pour des clients 0.6.19 et 0.6.18 ; ZIP et installeur
  accessibles (HTTP 200).
- Workflow Release vert ; CI du commit de la version verte.

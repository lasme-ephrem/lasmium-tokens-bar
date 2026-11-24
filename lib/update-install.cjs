'use strict';

// Remplacement du dossier portable après fermeture de l'application. Windows
// verrouille l'exécutable en cours : un script PowerShell séparé attend la fin
// du processus, sauvegarde l'ancienne version, copie la nouvelle puis relance.
// `data/` n'est jamais copié ni supprimé : il reste à côté de l'exécutable.

const fs = require('node:fs/promises');
const path = require('node:path');

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function findPackageRoot(staging) {
  const root = path.resolve(staging);
  async function walk(current, depth) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const hasExe = entries.some(entry => entry.isFile() && entry.name === 'LasmiumTokensHub.exe');
    const hasApp = await fs.stat(path.join(current, 'resources', 'app', 'main.cjs')).then(stat => stat.isFile()).catch(() => false);
    if (hasExe && hasApp) {
      if (await fs.stat(path.join(current, 'data')).then(stat => stat.isDirectory()).catch(() => false)) {
        throw new Error('L’archive de mise à jour contient un dossier data interdit.');
      }
      return current;
    }
    if (depth >= 2) throw new Error('Archive de mise à jour sans exécutable ou sans resources/app/main.cjs.');
    const directories = entries.filter(entry => entry.isDirectory());
    if (directories.length !== 1) throw new Error('Archive de mise à jour : structure racine ambiguë.');
    return walk(path.join(current, directories[0].name), depth + 1);
  }
  return walk(root, 0);
}

function buildWindowsInstallScript({ stagedRoot, targetRoot, executableName = 'LasmiumTokensHub.exe', appPid, logPath, startedPath }) {
  if (!Number.isSafeInteger(appPid) || appPid <= 0) throw new Error('PID invalide.');
  const staged = path.resolve(stagedRoot);
  const target = path.resolve(targetRoot);
  const dataRoot = path.join(target, 'data');
  const insideData = staged === dataRoot || staged.startsWith(dataRoot + path.sep);
  // Le téléchargement vit normalement dans <portable>/data/updates : autorisé.
  // En revanche, un package préparé ailleurs dans le portable serait copié
  // par-dessus l'application en cours, et une cible contenue dans le staging
  // provoquerait une copie récursive.
  if (staged === target || (staged.startsWith(target + path.sep) && !insideData)) {
    throw new Error('Le dossier préparé doit être hors du dossier portable, sauf sous data/.');
  }
  if (target === staged || target.startsWith(staged + path.sep)) {
    throw new Error('La cible ne doit pas être incluse dans le dossier préparé.');
  }
  if (executableName !== path.basename(executableName) || !/\.exe$/i.test(executableName)) throw new Error('Nom d’exécutable invalide.');
  const log = path.resolve(logPath);
  const started = path.resolve(startedPath || path.join(path.dirname(log), 'install.started'));
  return `$ErrorActionPreference = 'Stop'
$appPid = ${appPid}
$target = ${psQuote(target)}
$staged = ${psQuote(staged)}
$exeName = ${psQuote(executableName)}
$log = ${psQuote(log)}
$started = ${psQuote(started)}
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$exePath = Join-Path $target $exeName
$appDir = Join-Path $target 'resources\\app'
$appBackup = Join-Path $target ('resources\\app.rollback-' + $stamp)
$exeBackup = Join-Path $target ($exeName + '.rollback-' + $stamp)

# Accusé de démarrage : l'application attend ce fichier avant de quitter, pour
# ne pas tuer un script qui n'aurait pas encore eu le temps de s'exécuter.
$startedDir = Split-Path -Parent $started
if (-not (Test-Path -LiteralPath $startedDir)) { New-Item -ItemType Directory -Path $startedDir -Force | Out-Null }
Set-Content -LiteralPath $started -Value (Get-Date -Format o) -Encoding UTF8

function Write-Log([string]$message) {
  try {
    $dir = Split-Path -Parent $log
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o') + ' ' + $message)
  } catch { }
}

try {
  Write-Log "Attente de l'arrêt du processus $appPid"
  $deadline = (Get-Date).AddSeconds(60)
  while (Get-Process -Id $appPid -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) {
      Stop-Process -Id $appPid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 800
      break
    }
    Start-Sleep -Milliseconds 300
  }

  # Une seule sauvegarde de secours est conservée.
  Get-ChildItem -LiteralPath (Join-Path $target 'resources') -Directory -Filter 'app.rollback-*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 1 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $target -File -Filter ($exeName + '.rollback-*') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 1 | Remove-Item -Force -ErrorAction SilentlyContinue

  if (Test-Path -LiteralPath $appDir) { Move-Item -LiteralPath $appDir -Destination $appBackup }
  if (Test-Path -LiteralPath $exePath) { Move-Item -LiteralPath $exePath -Destination $exeBackup }
  try {
    # Les sous-processus Chromium peuvent relâcher leurs fichiers avec un léger
    # retard : Réessayer la copie plutôt que de rollback immédiatement.
    $copied = $false
    for ($attempt = 1; $attempt -le 20; $attempt++) {
      try {
        Copy-Item -Path (Join-Path $staged '*') -Destination $target -Recurse -Force
        $copied = $true
        break
      } catch {
        if ($attempt -eq 20) { throw }
        Start-Sleep -Milliseconds 500
      }
    }
    if (-not $copied) { throw 'Copie impossible.' }
    if (-not (Test-Path -LiteralPath $exePath)) { throw 'Nouvel exécutable absent après copie.' }
    if (-not (Test-Path -LiteralPath (Join-Path $appDir 'main.cjs'))) { throw 'Nouvelle application incomplète après copie.' }
  } catch {
    if (Test-Path -LiteralPath $appDir) { Remove-Item -LiteralPath $appDir -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $appBackup) { Move-Item -LiteralPath $appBackup -Destination $appDir }
    if (Test-Path -LiteralPath $exeBackup) { Move-Item -LiteralPath $exeBackup -Destination $exePath -Force }
    throw
  }
  Write-Log 'Mise à jour copiée ; redémarrage.'
  # L'application relancée ne se rattache à aucune console : fermer une fenêtre
  # de console ne peut pas l'arrêter.
  $env:ELECTRON_NO_ATTACH_CONSOLE = '1'
  Start-Process -FilePath $exePath -WorkingDirectory $target
  Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  Write-Log ('Échec de la mise à jour : ' + $_.Exception.Message)
  if ((Test-Path -LiteralPath $exePath) -eq $false -and (Test-Path -LiteralPath $exeBackup)) {
    Move-Item -LiteralPath $exeBackup -Destination $exePath -Force -ErrorAction SilentlyContinue
  }
  if ((Test-Path -LiteralPath $appDir) -eq $false -and (Test-Path -LiteralPath $appBackup)) {
    Move-Item -LiteralPath $appBackup -Destination $appDir -ErrorAction SilentlyContinue
  }
  $env:ELECTRON_NO_ATTACH_CONSOLE = '1'
  if (Test-Path -LiteralPath $exePath) { Start-Process -FilePath $exePath -WorkingDirectory $target -ErrorAction SilentlyContinue }
  exit 1
}
`;
}

module.exports = { findPackageRoot, buildWindowsInstallScript };

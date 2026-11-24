'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { findPackageRoot, buildWindowsInstallScript } = require('../lib/update-install.cjs');

function workspace(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Sous Windows, le script d'installation réel relance un processus détaché
  // qui peut garder un handle sur le dossier quelques secondes après la fin du
  // test : on réessaie, puis on laisse le dossier temporaire plutôt que de
  // faire échouer un test dont les assertions ont déjà réussi.
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
    catch (error) { if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error; }
  });
  return root;
}

// Interpréteur PowerShell disponible : `powershell.exe` (Windows PowerShell 5.1)
// puis `pwsh` (PowerShell 7, installable aussi sous Linux et macOS). La
// détection est paresseuse et mémorisée : aucun processus n'est lancé quand
// les tests concernés sont ignorés.
let powerShell;
function findPowerShell() {
  if (powerShell !== undefined) return powerShell;
  powerShell = null;
  for (const candidate of ['powershell.exe', 'pwsh']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (!probe.error && probe.status === 0) { powerShell = candidate; break; }
  }
  return powerShell;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

test('la racine du paquet est trouvée et une archive avec data/ est refusée', async t => {
  const root = workspace(t, 'lasmium-stage-');
  const pkg = path.join(root, 'LasmiumTokensHub-0.6.0-win32-x64');
  fs.mkdirSync(path.join(pkg, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'LasmiumTokensHub.exe'), 'exe');
  fs.writeFileSync(path.join(pkg, 'resources', 'app', 'main.cjs'), 'main');
  assert.equal(await findPackageRoot(root), pkg);
  fs.mkdirSync(path.join(pkg, 'data'));
  await assert.rejects(findPackageRoot(root), /data interdit/);
});

test('le script PowerShell échappe les chemins et refuse une cible incluse dans le staging', () => {
  const script = buildWindowsInstallScript({
    stagedRoot: path.join(os.tmpdir(), "stage-l'été"),
    targetRoot: path.join(os.tmpdir(), 'target'),
    appPid: 1234,
    logPath: path.join(os.tmpdir(), 'update.log'),
  });
  assert.match(script, /\$appPid = 1234/);
  assert.match(script, /stage-l''été/);
  assert.match(script, /Copy-Item/);
  assert.match(script, /Start-Process/);
  // Relance sans rattachement à une console, y compris en cas de retour arrière.
  assert.equal((script.match(/\$env:ELECTRON_NO_ATTACH_CONSOLE = '1'\r?\n\s*(?:if \(Test-Path -LiteralPath \$exePath\) \{ )?Start-Process/g) || []).length, 2);
  // PowerShell traite les guillemets typographiques comme des délimiteurs de chaîne.
  assert.doesNotMatch(script, /[\u2018\u2019\u201C\u201D]/);
  assert.throws(() => buildWindowsInstallScript({
    stagedRoot: path.join(os.tmpdir(), 'target', 'stage'),
    targetRoot: path.join(os.tmpdir(), 'target'),
    appPid: 1,
    logPath: 'log',
  }), /hors du dossier portable/);
  const portable = path.join(os.tmpdir(), 'portable-data');
  assert.match(buildWindowsInstallScript({
    stagedRoot: path.join(portable, 'data', 'updates', '0.6.2', 'staging'),
    targetRoot: portable,
    appPid: 1,
    logPath: path.join(portable, 'data', 'update.log'),
  }), /Copy-Item/);
  assert.throws(() => buildWindowsInstallScript({
    stagedRoot: path.join(os.tmpdir(), 'staging-parent'),
    targetRoot: path.join(os.tmpdir(), 'staging-parent', 'portable'),
    appPid: 1,
    logPath: 'log',
  }), /incluse dans le dossier préparé/);
});

test('le script d’installation généré est accepté par l’analyseur PowerShell', { timeout: 30000 }, t => {
  const shell = findPowerShell();
  if (!shell) { t.skip('ni powershell.exe ni pwsh n’est disponible'); return; }
  const root = workspace(t, 'lasmium-install-parse-');
  const scriptPath = path.join(root, 'install.ps1');
  fs.writeFileSync(scriptPath, buildWindowsInstallScript({
    stagedRoot: path.join(root, "stage-l'été"),
    targetRoot: path.join(root, 'target'),
    appPid: 2147483647,
    logPath: path.join(root, 'target', 'data', 'updates', 'update.log'),
  }));
  // Analyse syntaxique seule : le script n'est pas exécuté.
  const command = [
    '$errors = $null',
    `[System.Management.Automation.Language.Parser]::ParseFile(${psQuote(scriptPath)}, [ref]$null, [ref]$errors) | Out-Null`,
    'if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }',
    "'analyse-ok'",
  ].join('; ');
  const output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.match(output, /analyse-ok/);
});

test('le script d’installation remplace l’application et préserve data/', { timeout: 30000 }, t => {
  // Le script manipule des chemins Windows (`resources\app`), attend la fin
  // d'un PID Windows et relance un `.exe` : son exécution réelle n'a de sens
  // que sous Windows, avec powershell.exe ou, à défaut, pwsh.
  const shell = process.platform === 'win32' ? findPowerShell() : null;
  if (!shell) { t.skip(process.platform === 'win32' ? 'aucun interpréteur PowerShell disponible' : 'exécution réelle du script réservée à Windows'); return; }
  const root = workspace(t, 'lasmium-install-');
  const target = path.join(root, 'portable');
  const staged = path.join(root, 'staged');
  fs.mkdirSync(path.join(target, 'resources', 'app'), { recursive: true });
  fs.mkdirSync(path.join(target, 'data'), { recursive: true });
  fs.writeFileSync(path.join(target, 'LasmiumTokensHub.exe'), 'old-exe');
  fs.writeFileSync(path.join(target, 'resources', 'app', 'main.cjs'), 'old-main');
  fs.writeFileSync(path.join(target, 'data', 'state.json'), 'précieux');
  fs.mkdirSync(path.join(staged, 'resources', 'app'), { recursive: true });
  fs.copyFileSync('C:\\Windows\\System32\\where.exe', path.join(staged, 'LasmiumTokensHub.exe'));
  fs.writeFileSync(path.join(staged, 'resources', 'app', 'main.cjs'), 'new-main');
  const scriptPath = path.join(root, 'install.ps1');
  fs.writeFileSync(scriptPath, buildWindowsInstallScript({
    stagedRoot: staged,
    targetRoot: target,
    appPid: 2147483647,
    logPath: path.join(target, 'data', 'updates', 'update.log'),
  }));
  execFileSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { timeout: 20000 });
  assert.equal(fs.readFileSync(path.join(target, 'resources', 'app', 'main.cjs'), 'utf8'), 'new-main');
  assert.equal(fs.readFileSync(path.join(target, 'data', 'state.json'), 'utf8'), 'précieux');
  assert.ok(fs.existsSync(path.join(target, 'data', 'updates', 'install.started')));
  assert.ok(fs.readdirSync(path.join(target, 'resources')).some(name => name.startsWith('app.rollback-')));
});

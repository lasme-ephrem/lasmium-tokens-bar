const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let desktop;

async function main() {
  const results = path.join(root, 'test-results');
  await fs.mkdir(results, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(results, 'resource-status-data-'));
  const env = { ...process.env, PROVIDERSBAR_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: process.env.PROVIDERSBAR_EXECUTABLE || require('electron'), args: [...(process.env.PROVIDERSBAR_EXECUTABLE ? [] : [root]), '--no-sandbox', '--disable-gpu'], cwd: root, env, timeout: 30000 });
  const dashboard = await desktop.firstWindow();
  await dashboard.waitForSelector('.card');
  // Le widget peut être créé après la fenêtre principale : attendre sa création.
  let widget;
  for (let attempt = 0; attempt < 50 && !widget; attempt++) {
    widget = desktop.windows().find(w => w.url().includes('mode=quick'));
    if (!widget) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(widget, 'fenêtre widget (mode=quick) introuvable');
  await widget.waitForSelector('.quick-row');
  const errors = [];
  for (const surface of [dashboard, widget]) surface.on('pageerror', error => errors.push(error.message));
  const card = id => dashboard.locator(`.card:has([data-open="${id}"])`);
  const row = id => widget.locator(`[data-provider="${id}"]`);
  // Fixtures exist only in the two renderers and never overwrite account data.
  async function fixture(id, snapshot) {
    for (const surface of [dashboard, widget]) await surface.evaluate(({ id, snapshot }) => {
      page = 'overview'; filter = 'all'; query = '';
      const provider = state.providers.find(p => p.id === id);
      Object.assign(provider, { active: true, connected: true, syncing: false, subscriptionStatus: 'active', renewalDate: '2099-12-31', error: null, snapshot: { source: 'api', updatedAt: new Date().toISOString(), balances: [], ...snapshot } });
      render();
    }, { id, snapshot });
  }
  for (const theme of ['light', 'dark']) {
    // Le renderer applique le thème depuis state.settings.theme à chaque rendu :
    // forcer l'état est la seule façon déterministe de tester les deux palettes.
    for (const surface of [dashboard, widget]) await surface.evaluate(theme => { state.settings.theme = theme; document.documentElement.dataset.theme = theme; }, theme);
    for (const currency of ['USD', 'EUR', 'CNY']) {
      for (const id of ['openrouter', 'deepseek', 'runinfra']) {
        await fixture(id, { balances: [{ currency, remaining: -0.08 }], quotaRemaining: null });
        for (const container of [card(id), row(id)]) {
          assert.match(await container.getAttribute('class'), /resource-empty/);
          // Le widget 0.3.0 exprime l'épuisement par la pastille textuelle
          // « Épuisé » ; la carte du tableau de bord garde « Solde épuisé ».
          assert.match(await container.innerText(), /Épuisé/);
          const color = await container.locator('.resource-value, .quick-fact-value').first().evaluate(el => getComputedStyle(el).color);
          const [r, g, b] = color.match(/[\d.]+/g).map(Number);
          assert.ok(r > g && r > b, `${id}/${currency}/${theme} should be red: ${color}`);
        }
        assert.match(await card(id).innerText(), /Solde épuisé/);
      }
    }
  }
  const windowSets = {
    claude: [['Semaine', 'Limite hebdo atteinte'], ['Fable · Semaine', 'Limite hebdo Fable atteinte'], ['5 heures', 'Limite horaire atteinte']],
    zai: [['Semaine', 'Limite hebdo atteinte'], ['5 heures', 'Limite horaire atteinte']],
    antigravity: [['Gemini · Semaine', 'Limite Gemini · hebdo atteinte'], ['Gemini · 5 heures', 'Limite Gemini · horaire atteinte'], ['Claude et GPT · Semaine', 'Limite Claude / GPT · hebdo atteinte'], ['Claude et GPT · 5 heures', 'Limite Claude / GPT · horaire atteinte'], ['Gemini 4 Argon · Semaine', 'Limite hebdo Argon atteinte']],
    openai: [['Codex et Work · Semaine', 'Limite Codex et Work · hebdo atteinte']],
    grok: [['Semaine', 'Limite Grok · hebdo atteinte'], ['Grok Bot · Semaine', 'Limite Grok Bot · hebdo atteinte']],
  };
  // Libellé exact tel que rendu par le widget vertical (groupes compris).
  const quickLabel = label => {
    if (label === 'Fable · Semaine') return 'Hebdo Fable';
    const parts = label.split(' · ');
    const period = parts.pop();
    const group = parts.join(' · ');
    const periodLabel = period === 'Semaine' ? 'Hebdo' : period === '5 heures' ? 'Horaire' : period;
    if (group === 'Gemini 4 Argon') return 'Hebdo Argon';
    if (group === 'Codex et Work') return periodLabel;
    if (group) return (group === 'Claude et GPT' ? 'Claude / GPT' : group) + ' · ' + periodLabel;
    return periodLabel;
  };
  const factLabels = id => row(id).locator('.quick-fact-label').allTextContents();
  for (const [id, windows] of Object.entries(windowSets)) {
    for (const [exhausted, expected] of windows) {
      await fixture(id, { quotaRemaining: 0, quotaWindows: windows.map(([label]) => ({ label, remaining: label === exhausted ? 0 : 100 })) });
      assert.deepEqual(await card(id).locator('.quota-period-status').allTextContents(), [expected]);
      // Widget vertical : une information par fenêtre, aucune masquée par « +N ».
      const labels = await factLabels(id);
      assert.equal(labels.length, windows.length, `le widget doit afficher toutes les fenêtres de ${id}`);
      const expectedLabel = quickLabel(exhausted);
      assert.ok(labels.some(label => label === expectedLabel || label.endsWith(' · ' + expectedLabel)), `${id}: libellé ${expectedLabel} absent de ${labels.join(', ')}`);
      const facts = await row(id).locator('.quick-fact').evaluateAll(items => items.map(item => ({
        label: item.querySelector('.quick-fact-label')?.textContent || '',
        value: item.querySelector('.quick-fact-value')?.textContent || '',
        classes: item.querySelector('.quick-fact-value')?.className || '',
      })));
      const exhaustedFact = facts.find(fact => fact.label === quickLabel(exhausted))
        || facts.find(fact => fact.label.endsWith(' · ' + quickLabel(exhausted)));
      assert.ok(exhaustedFact, `${id}: information Widget introuvable pour ${exhausted}`);
      assert.match(exhaustedFact.classes, /resource-empty/);
      assert.match(exhaustedFact.value, /^0\s*%$/);
      // Le chip de ligne reflète le niveau agrégé : une seule fenêtre épuisée ne
      // rend pas toute la ligne « Épuisé » si une autre reste suffisante.
      const rowClass = await row(id).getAttribute('class');
      if (windows.length === 1) assert.match(rowClass, /resource-empty/);
      else assert.doesNotMatch(rowClass, /resource-empty/);
    }
    await fixture(id, { quotaWindows: windows.map(([label]) => ({ label, remaining: 0 })) });
    const expected = windows.length > 1 ? 'Toutes les limites atteintes' : 'Limite atteinte';
    assert.equal(await card(id).locator('.resource-status').innerText(), expected);
    assert.match(await row(id).getAttribute('class'), /resource-empty/);
    assert.match(await row(id).locator('.quick-level').innerText(), /Épuisé/);
    const allFactClasses = await row(id).locator('.quick-fact-value').evaluateAll(items => items.map(item => item.className));
    for (const classes of allFactClasses) assert.match(classes, /resource-empty/);
  }
  await fixture('grok', { usageKind: 'x-subscription-shared', quotaWindows: [{ label: 'Semaine', remaining: 40 }] });
  assert.equal(await card('grok').locator('.quota-period').count(), 1);
  assert.deepEqual(await factLabels('grok'), ['Grok / Bot / Cursor · Hebdo']);
  assert.match(await row('grok').locator('.quick-level').innerText(), /Suffisant/);
  assert.match(await card('grok').innerText(), /grok \/ bot \/ cursor/i);
  await fixture('claude', { quotaWindows: [{ label: 'Semaine', remaining: 0 }, { label: '5 heures', remaining: 0 }, { label: 'Fable · Semaine', remaining: 100 }] });
  assert.equal(await card('claude').locator('.resource-status').count(), 0);
  const claudeFacts = await row('claude').locator('.quick-fact').evaluateAll(items => items.map(item => ({
    label: item.querySelector('.quick-fact-label')?.textContent || '',
    classes: item.querySelector('.quick-fact-value')?.className || '',
  })));
  assert.deepEqual(claudeFacts.map(fact => fact.label), ['Hebdo', 'Horaire', 'Hebdo Fable']);
  assert.match(claudeFacts[0].classes, /resource-empty/);
  assert.match(claudeFacts[1].classes, /resource-empty/);
  assert.match(claudeFacts[2].classes, /resource-healthy/);
  assert.doesNotMatch(await row('claude').getAttribute('class'), /resource-empty/);
  // Situation exacte signalée, conservée dans les captures.
  await fixture('claude', { quotaWindows: [{ label: 'Semaine', remaining: 18 }, { label: 'Fable · Semaine', remaining: 0 }, { label: '5 heures', remaining: 100 }] });
  await fixture('openrouter', { balances: [{ currency: 'USD', remaining: -0.08 }] });
  for (const surface of [dashboard, widget]) await surface.evaluate(() => { state.settings.theme = 'light'; document.documentElement.dataset.theme = 'light'; });
  await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('mode=quick')).show(); });
  await dashboard.screenshot({ path: path.join(results, 'resource-status-dashboard.png'), fullPage: true });
  await widget.screenshot({ path: path.join(results, 'resource-status-widget.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: negative balances red for all 3 APIs in USD/EUR/CNY and both themes; per-window quota statuses on dashboard cards (Hebdo/Horaire/Hebdo Argon) ; widget vertical complet (une ligne par fenêtre, aucune masquée, fact-values colorées, chip agrégé) ; global status only when every displayed limit is exhausted ; dashboard and widget.');
}
// Un smoke en échec se termine toujours : fermeture d'Electron bornée à 15 s,
// puis sortie explicite (sinon un Electron bloqué occupe la CI jusqu'au délai).
async function finish(failed) {
  if (desktop) await Promise.race([desktop.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 15000))]);
  if (failed) process.exit(1);
}

main().then(() => finish(false), async error => { console.error(error); await finish(true); });

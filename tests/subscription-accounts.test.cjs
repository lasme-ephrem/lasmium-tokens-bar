const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { accounts, inspectSubscriptionPage, parseAccountUsage } = require('../lib/subscription-accounts.cjs');
const { connectionInfo } = require('../lib/provider-catalog.cjs');
const { createSubscriptionController } = require('../lib/subscription-controller.cjs');

function inspect(id, text, { login = false, authenticated = false, conversation = false, foreign = false, page = 'usage' } = {}) {
  const url = new URL(id === 'grok' && page === 'legacy' ? 'https://grok.com/settings/usage' : accounts[id].usageUrl||accounts[id].url);
  const heading = { innerText: 'Usage', getClientRects: () => [1] };
  const node = text => ({ innerText: text, getAttribute: () => null, getClientRects: () => [1], querySelector: () => heading, querySelectorAll: selector => selector.startsWith('h1') ? [heading] : [] });
  const controls = [ ...(login ? [node('Sign in')] : []), ...(authenticated ? [node('Log out')] : []) ];
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${inspectSubscriptionPage.toString()})(${JSON.stringify(id)}, ${JSON.stringify(url.origin)})`, {
    location: { origin: foreign ? 'https://accounts.google.com' : url.origin, pathname: conversation ? '/chat/123' : url.pathname }, window: {},
    document: { querySelectorAll: selector => selector.startsWith('button') ? controls : conversation ? [] : selector.startsWith('main') && page !== 'legacy' ? [node(text)] : id === 'grok' && page === 'legacy' && selector.startsWith('[role="dialog"]') ? [node(text)] : [] },
  })));
}

test('Active subscription portals have account connectors and explicit windows, no monetary balance', () => {
  for (const id of Object.keys(accounts).filter(id=>!['openai','claude'].includes(id))) {
    assert.equal(connectionInfo(id).mode, 'account');
    const result = inspect(id, '5 hour usage limit\n80% remaining\nWeekly usage limit\n35% used\nResets 2026-10-07T12:00:00Z');
    const s = parseAccountUsage(id, result);
    assert.equal(s.quotaRemaining, 65);
    assert.equal(s.quotaWindows.length, id === 'grok' ? 1 : 2);
    assert.equal(s.resetAt, '2026-10-07T12:00:00.000Z');
    assert.deepEqual(s.balances, []);
    assert.match(s.quotaLabel, /Semaine/);
    assert.equal('usageKind' in s, id === 'grok');
    if (id === 'grok') assert.equal(s.usageKind, 'x-subscription-shared');
  }
});
test('Claude Pro reads only the session and weekly percentages from usage settings', () => {
  const text='Votre utilisation\nPro\nNouvelle semaine. 9% de votre limite hebdomadaire utilisée.\nSession actuelle\nRéinitialisation à 4:40\n12 % utilisés\nCette semaine\nRéinitialisation le mercredi 10:00\n9 % utilisés\nCrédits d’utilisation\n100 %';
  const result=inspect('claude',text);
  const snapshot=parseAccountUsage('claude',result);
  assert.deepEqual(snapshot.quotaWindows.map(w=>[w.label,w.remaining]),[['5 heures',88],['Semaine',91]]);
  assert.equal(snapshot.quotaRemaining,88);
  for (const options of [{login:true},{foreign:true},{conversation:true}]) assert.equal(inspect('claude',text,options).authenticated,false);
  assert.equal(parseAccountUsage('claude',inspect('claude','Votre utilisation\nSession actuelle\n12 %\nCette semaine\n9 %')),null);
});
test('French wording, zero and 100 are preserved; ambiguous values never invent a quota', () => {
  const s = parseAccountUsage('grok', inspect('grok', '5 heures\n100 % utilisés\nSemaine\n0 % consommés', { page: 'legacy' }));
  assert.equal(s.quotaRemaining, 0);
  assert.equal(s.quotaWindows[1].remaining, 100);
  for (const text of ['Weekly limit\n50%', 'Weekly limit\n$20 per month', 'Weekly limit\n101% used']) {
    assert.equal(parseAccountUsage('grok', inspect('grok', text, { authenticated: true })), null);
  }
  assert.throws(() => parseAccountUsage('grok', inspect('grok', 'Weekly limit\n20% used\nWeekly limit\n30% used', { authenticated: true })), { code: 'ACCOUNT_USAGE_INVALID' });
  assert.throws(() => parseAccountUsage('zai', { authenticated: true, windows: [{ label: 'Semaine', remaining: NaN, resetAt: null }] }));
});
test('Z.ai French mistranslated Used labels retain separate quotas and do not report an expired session', () => {
  for (const apostrophe of ["'", '’']) {
    const result = inspect('zai', `Limite de 5 heures\n12,5\n%\nD${apostrophe}occasion\nCrédits\n250 / 2K\nLimite hebdomadaire\n100\n%\nD${apostrophe}occasion\nCrédits\n10 000 / 10 000`);
    assert.equal(result.authenticated, true);
    const snapshot = parseAccountUsage('zai', result);
    assert.deepEqual(snapshot.quotaWindows.map(w => [w.label, w.remaining]), [['5 heures', 87.5], ['Semaine', 0]]);
  }
  assert.equal(parseAccountUsage('zai', inspect('zai', "Limite de 5 heures\n0\n%\nD'occasion")).quotaRemaining, 100);
});

test('Z.ai translation is limited to explicit quota values and never bypasses login or origin checks', () => {
  const text = "Limite hebdomadaire\n20\n%\nD'occasion";
  for (const options of [{ login: true }, { foreign: true }, { conversation: true }]) {
    assert.equal(inspect('zai', text, options).authenticated, false);
  }
  for (const invalid of ["Limite hebdomadaire\n20%", "Limite hebdomadaire\n101% D'occasion", "Limite hebdomadaire\nActivité\n20% D'occasion"]) {
    assert.deepEqual(inspect('zai', invalid).windows, []);
  }
  assert.deepEqual(inspect('grok', text).windows, []);
});

test('OpenAI uses Codex authentication without forcing a web analytics redirect', () => {
  assert.equal(accounts.openai.url, 'https://chatgpt.com/');
  assert.equal(connectionInfo('openai').codexAccount, true);
});
test('Grok X Subscription reads one shared weekly total from Dashboard Usage and ignores breakdowns', () => {
  assert.equal(accounts.grok.usageUrl, 'https://grok.com/dashboard');
  assert.equal(accounts.grok.fallbackUsageUrl, 'https://grok.com/?_s=usage');
  assert.match(accounts.grok.hint, /ne fusionne pas de comptes et ne change aucun forfait/);
  const panel = text => ({ innerText: text, getClientRects: () => [1], querySelectorAll: selector => selector.startsWith('h1') ? [{ innerText: 'Usage', getClientRects: () => [1] }] : [] });
  for (const [percentage, direction, remaining] of [['0%', 'used', 100], ['100%', 'used', 0], ['12,5 %', 'used', 87.5], ['0%', 'remaining', 0]]) {
    const flow = value => ({ getClientRects: () => [1], getAttribute: () => value, parentElement: { innerText: direction } });
    const dashboard = panel('Usage\nWeekly usage\nBy product\nGrok 90% used\nGrok Bot 70% used\nCursor 20% used\nAdditional usage credits\n$25.00');
    dashboard.querySelectorAll = selector => selector.startsWith('h1') ? [{ innerText: 'Usage', getClientRects: () => [1] }] : [flow(percentage), flow('90%')];
    const result = JSON.parse(JSON.stringify(vm.runInNewContext(`(${inspectSubscriptionPage.toString()})('grok','https://grok.com')`, {
      location: { origin: 'https://grok.com', pathname: '/dashboard' }, window: {},
      document: { title: 'Grok', querySelectorAll: selector => selector.startsWith('button') ? [{ innerText: 'Log out', getAttribute: () => null, getClientRects: () => [1] }] : selector.startsWith('main') ? [dashboard] : [] },
    })));
    assert.equal(result.usageKind, 'x-subscription-shared');
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].label, 'Semaine');
    const snapshot = parseAccountUsage('grok', result);
    assert.equal(snapshot.usageKind, 'x-subscription-shared');
    assert.equal(snapshot.quotaRemaining, remaining);
    assert.match(snapshot.quotaLabel, /X Subscription · Pool partagé Grok, Grok Bot et Cursor · Semaine/);
    assert.deepEqual(snapshot.balances, []);
  }
});
test('Grok legacy SuperGrok settings stay separate from the shared pool and report conflicts safely', () => {
  const result = inspect('grok', 'Paramètres\nUtilisation\nLimite hebdomadaire SuperGrok\n25% used\nCrédits supplémentaires\n$25.00', { authenticated: true, page: 'legacy' });
  assert.equal(result.usageKind, 'supergrok-legacy');
  const snapshot = parseAccountUsage('grok', result);
  assert.equal(snapshot.usageKind, 'supergrok-legacy');
  assert.equal(snapshot.quotaRemaining, 75);
  assert.match(snapshot.quotaLabel, /Quotas SuperGrok historiques séparés · Grok et Grok Bot · Semaine/);
  assert.deepEqual(snapshot.balances, []);
  assert.throws(() => parseAccountUsage('grok', inspect('grok', 'Weekly limit\n20% used\nWeekly limit\n30% used', { authenticated: true })), { code: 'ACCOUNT_USAGE_INVALID' });
});
test('SuperGrok usage settings pair each weekly heading with its own animated value and exact French reset time', () => {
  const flow = (value, parentText) => ({ getClientRects: () => [1], getAttribute: name => name === 'aria-label' ? value : null, parentElement: { innerText: parentText, getClientRects: () => [1] } });
  const quotaCard = (title, value, direction, reset, detail) => {
    const heading = { innerText: title, getClientRects: () => [1] };
    const number = flow(`${value}% ${direction}`, `${value}% ${direction}`);
    return { heading, number, text: `${title}\n${value}% ${direction}\nRéinitialisation le ${reset}\n${detail}` };
  };
  const grok = quotaCard('Limite hebdomadaire SuperGrok', 8, 'utilisés', '21 octobre 2026 à 20:14', 'Grok Build 8%');
  const bot = quotaCard('Weekly Grok Bot Limit', 0, 'used', '24 octobre 2026 à 16:12', 'Utilisation de Grok Bot 0');
  const headings = [{ innerText: 'Utilisation', getClientRects: () => [1] }, grok.heading, bot.heading], flows = [grok.number, bot.number];
  const panel = { innerText: `Grok Bot a une limite hebdomadaire distincte.\n${grok.text}\n${bot.text}`, getClientRects: () => [1],
    querySelectorAll: selector => selector.startsWith('h1') ? headings : selector.startsWith('number-flow') ? flows : [] };
  grok.heading.parentElement = panel; bot.heading.parentElement = panel;
  const result = JSON.parse(JSON.stringify(vm.runInNewContext(`(${inspectSubscriptionPage.toString()})('grok','https://grok.com')`, {
    location: { origin: 'https://grok.com', pathname: '/' }, window: {},
    document: { title: 'Grok', querySelectorAll: selector => selector.startsWith('button') ? [{ innerText: 'Log out', getAttribute: () => null, getClientRects: () => [1] }] : selector.startsWith('[role="dialog"]') ? [panel] : [] },
  })));
  assert.equal(result.usageKind, 'supergrok-legacy');
  assert.deepEqual(result.windows.map(window => [window.label, window.remaining]), [['Semaine', 92], ['Grok Bot · Semaine', 100]]);
  const snapshot = parseAccountUsage('grok', result);
  assert.equal(snapshot.quotaRemaining, 92);
  assert.deepEqual(snapshot.quotaWindows.map(window => [window.label, window.remaining]), [['Semaine', 92], ['Grok Bot · Semaine', 100]]);
  assert.equal(snapshot.quotaWindows[0].resetAt, new Date(2026, 9, 21, 20, 14).toISOString());
  assert.equal(snapshot.quotaWindows[1].resetAt, new Date(2026, 9, 24, 16, 12).toISOString());
});
test('SuperGrok settings of November 2026 (plain-text percentages) keep Grok and Grok Bot apart and skip the breakdown', () => {
  // Texte réel du panneau Paramètres → Utilisation (14 novembre 2026), sans number-flow.
  const text = 'Paramètres\nCompte\nFacturation\nUtilisation\nUtilisation\nLimite hebdomadaire SuperGrok\n24 %\nutilisés\nRéinitialisation le 18 novembre 2026 à 19:14\nImagine\n21 %\nApp Builder\n3 %\nCrédits d\'utilisation supplémentaires\nSolde : 0,00 $US\nAcheter des crédits\nWeekly Grok Bot Limit\n8 %\nutilisés\nRéinitialisation le 21 novembre 2026 à 15:12';
  const headings = ['Paramètres', 'Utilisation', 'Limite hebdomadaire SuperGrok', 'Weekly Grok Bot Limit'].map(innerText => ({ innerText, getClientRects: () => [1] }));
  const panel = { innerText: text, getClientRects: () => [1], querySelectorAll: selector => selector.startsWith('h1') ? headings : [] };
  for (const heading of headings) heading.parentElement = panel;
  const read = value => JSON.parse(JSON.stringify(vm.runInNewContext(`(${inspectSubscriptionPage.toString()})('grok','https://grok.com')`, {
    location: { origin: 'https://grok.com', pathname: '/' }, window: {},
    document: { title: 'Grok', querySelectorAll: selector => selector.startsWith('button') ? [{ innerText: 'Log out', getAttribute: () => null, getClientRects: () => [1] }] : selector.startsWith('[role="dialog"]') ? [value] : [] },
  })));
  const result = read(panel);
  assert.equal(result.blocked, undefined, 'plus de « quotas contradictoires »');
  assert.equal(result.usageKind, 'supergrok-legacy');
  const snapshot = parseAccountUsage('grok', result);
  assert.deepEqual(snapshot.quotaWindows.map(window => [window.label, window.remaining]), [['Semaine', 76], ['Grok Bot · Semaine', 92]]);
  assert.equal(snapshot.quotaWindows[0].resetAt, new Date(2026, 10, 18, 19, 14).toISOString());
  assert.equal(snapshot.quotaWindows[1].resetAt, new Date(2026, 10, 21, 15, 12).toISOString());
  assert.equal(snapshot.quotaRemaining, 76);
  // Un titre sans pourcentage direct (seulement le détail par produit) ne crée aucune valeur.
  const noTotal = { ...panel, innerText: 'Utilisation\nLimite hebdomadaire SuperGrok\nImagine\n21 %\nApp Builder\n3 %' };
  const onlyGrok = [headings[1], headings[2]];
  noTotal.querySelectorAll = selector => selector.startsWith('h1') ? onlyGrok : [];
  assert.deepEqual(read(noTotal).windows, []);
});
test('A legacy two-limit panel remains separate even when shown under Dashboard Usage', () => {
  const flow = (value, direction) => ({ innerText: '', getClientRects: () => [1], getAttribute: name => name === 'aria-label' ? `${value}% used` : null,
    parentElement: { innerText: direction, getClientRects: () => [1] } });
  const quotaCard = (title, value) => {
    const heading = { innerText: title, getClientRects: () => [1] };
    const number = flow(value, 'used');
    const card = { innerText: `${title}\n${value}% used`, getClientRects: () => [1], querySelectorAll: selector => selector.startsWith('h1') ? [heading] : selector.startsWith('number-flow') ? [number] : [] };
    heading.parentElement = card;
    return { heading, number, card };
  };
  const grok = quotaCard('Limite hebdomadaire SuperGrok', 8), bot = quotaCard('Weekly Grok Bot Limit', 0);
  const headings = [{ innerText: 'Usage', getClientRects: () => [1] }, grok.heading, bot.heading];
  const flows = [grok.number, bot.number];
  const dashboard = { innerText: `Usage\nWeekly usage\n${grok.card.innerText}\n${bot.card.innerText}`, getClientRects: () => [1],
    querySelectorAll: selector => selector.startsWith('h1') ? headings : selector.startsWith('number-flow') ? flows : [] };
  grok.card.parentElement = dashboard; bot.card.parentElement = dashboard;
  const result = JSON.parse(JSON.stringify(vm.runInNewContext(`(${inspectSubscriptionPage.toString()})('grok','https://grok.com')`, {
    location: { origin: 'https://grok.com', pathname: '/dashboard' }, window: {},
    document: { title: 'Grok', querySelectorAll: selector => selector.startsWith('button') ? [{ innerText: 'Log out', getAttribute: () => null, getClientRects: () => [1] }] : selector.startsWith('main') ? [dashboard] : [] },
  })));
  assert.equal(result.usageKind, 'supergrok-legacy');
  assert.deepEqual(result.windows.map(window => [window.label, window.remaining]), [['Semaine', 92], ['Grok Bot · Semaine', 100]]);
});
test('Reopening cancels an in-flight background read instead of waiting for its timeout', async () => {
  const events=[];
  const c=createSubscriptionController({dataDir:'test-only',onChange(){},onResult:async()=>assert.fail('Cancelled read must not be saved'),deleteProfile:async()=>{},openBrowser:async(_dir,id,headless,{signal}={})=>{
    if(headless){events.push('background');await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}
    events.push('interactive');return {isOpen:()=>true,close:async()=>{},readSubscriptionPage:async()=>({authenticated:false,windows:[]})};
  }});
  const reading=c.read('grok',{background:true}).catch(()=>{});
  const start=Date.now();await c.open('grok');await reading;
  assert.ok(Date.now()-start<500);assert.deepEqual(events,['background','interactive']);
  await c.closeAll();
});
test('A closed browser never erases the actionable verification error', async t => {
  t.mock.timers.enable({apis:['setInterval']});let failure;
  const c=createSubscriptionController({dataDir:'test-only',onChange(){},onResult:async()=>assert.fail('Not authenticated'),onFailure:async(_id,message)=>{failure=message;},deleteProfile:async()=>{},openBrowser:async()=>({isOpen:()=>false,close:async()=>{},readSubscriptionPage:async()=>({authenticated:false,windows:[]})})});
  await c.open('zai');
  // Fresh background verification, no successful session; simulated clock keeps this bounded.
  await assert.rejects(c.read('zai'), /Ouvre le compte/);
  // Verify a browser that closes during its failed read.
  await c.closeAll();
  let open=true;
  const d=createSubscriptionController({dataDir:'test-only',onChange(){},onResult:async()=>assert.fail(),onFailure:async(_id,message)=>{failure=message;},deleteProfile:async()=>{},openBrowser:async()=>({isOpen:()=>open,close:async()=>{open=false;},readSubscriptionPage:async()=>{open=false;return {authenticated:false,windows:[]};}})});
  await d.open('zai');await assert.rejects(d.read('zai',{automatic:true}),{code:'ACCOUNT_SIGNIN'});
  t.mock.timers.tick(2000);assert.equal(d.info('zai').status,'error');assert.match(failure,/absente ou expirée/);
  await d.closeAll();
});
test('Public sign-in pages, foreign origins and conversation text cannot authenticate or create quotas', () => {
  for (const options of [{ login: true }, { foreign: true }, { conversation: true }]) {
    const result = inspect('grok', 'Weekly limit\n20% used', options);
    assert.equal(result.authenticated, false);
    assert.throws(() => parseAccountUsage('grok', result), { code: 'ACCOUNT_SIGNIN' });
  }
  assert.throws(() => parseAccountUsage('__proto__', {}));
});
test('Labelled Grok avatar opens usage settings without itself proving authentication', () => {
  const window={};let menu=false,settings=false,usage=false;
  const node=(text,attributes={})=>({innerText:text,tagName:'BUTTON',getAttribute:name=>attributes[name]||null,getClientRects:()=>[1],querySelector:()=>null});
  const avatar=node('',{'aria-label':'Compte','aria-haspopup':'menu'});
  avatar.querySelector=selector=>selector==='img'?{}:null;
  avatar.dispatchEvent=event=>{if(event.type==='pointerdown')menu=true;};
  const settingsButton=node('Paramètres');settingsButton.click=()=>{settings=true;};
  const usageButton=node('Utilisation');usageButton.click=()=>{usage=true;};
  const panel=node('Weekly limit\n20% used');panel.querySelectorAll=selector=>selector.startsWith('h1')?[node('Utilisation')]:[];
  const context={window,location:{origin:'https://grok.com',pathname:'/'},PointerEvent:class{constructor(type){this.type=type;}},document:{title:'Grok',querySelectorAll:selector=>selector.startsWith('button')?[avatar,...(menu?[node('Se déconnecter'),settingsButton]:[]),...(settings?[usageButton]:[])]:selector.startsWith('[role="dialog"]')&&usage?[panel]:[]}};
  const read=()=>JSON.parse(JSON.stringify(vm.runInNewContext(`(${inspectSubscriptionPage.toString()})('grok','https://grok.com')`,context)));
  assert.equal(read().authenticated,false);assert.equal(menu,true);
  assert.equal(read().authenticated,true);assert.equal(settings,true);
  read();assert.equal(usage,true);
  assert.equal(parseAccountUsage('grok',read()).quotaRemaining,80);
});
function harness() {
  const reads = [], opens = [], deleted = [], closed = [];
  let result = { authenticated: true, windows: [{ label: 'Semaine', remaining: 75, resetAt: null }] };
  const controller = createSubscriptionController({ dataDir: 'test-only', onChange() {},
    openBrowser: async (_dir, id, headless) => {
      opens.push({ id, headless }); let open = true;
      return { isOpen: () => open, readSubscriptionPage: async () => result, close: async () => { open = false; closed.push(id); } };
    }, deleteProfile: async (_dir, id) => deleted.push(id), onResult: async (id, snapshot) => reads.push({ id, snapshot }),
  });
  return { controller, reads, opens, deleted, closed, result: value => { result = value; } };
}

test('Grok reads the nested French Usage heading and animated accessible percentage, including zero and exhausted quotas', () => {
  const node = text => ({ innerText: text, getClientRects: () => [1], getAttribute: () => null });
  for (const [percentage, remaining] of [['0%', 100], ['100%', 0], ['12,5 %', 87.5], ['101%', null], ['0,00 $US', null]]) {
    const number = { ...node(''), getAttribute: () => percentage, parentElement: node('utilisés') };
    const panel = { ...node('Paramètres\nCompte\nUtilisation\nLimite hebdomadaire SuperGrok\nutilisés\nCrédits supplémentaires'),
      querySelectorAll: selector => selector.startsWith('h1') ? [node('Paramètres'), node('Utilisation'), node('Limite hebdomadaire SuperGrok')] : [number] };
    const read = (origin = 'https://grok.com') => JSON.parse(JSON.stringify(vm.runInNewContext(`(${inspectSubscriptionPage.toString()})('grok','https://grok.com')`, {
      location: { origin, pathname: '/' }, window: {}, document: { title: 'Grok', querySelectorAll: selector => selector.startsWith('button') ? [node('Se déconnecter')] : [panel] },
    })));
    const result = read();
    assert.equal(result.authenticated, true);
    assert.equal(parseAccountUsage('grok', result)?.quotaRemaining ?? null, remaining);
    assert.equal(read('https://grok.com.evil.example').authenticated, false);
  }
});

test('Grok and Z.ai human checks are visible during manual verification and close after success or failure', async () => {
  for (const id of ['grok', 'zai']) {
    let reads = 0, closed = 0, saved = 0;
    const updates = [];
    const controller = createSubscriptionController({ dataDir: 'test-only', wait: async () => {}, onChange() { updates.push(controller.info(id).status); },
      deleteProfile: async () => {}, onResult: async () => { saved++; },
      openBrowser: async (_dir, actualId, headless, options) => {
        assert.equal(actualId, id); assert.equal(headless, true); assert.equal(options.interactive, true);
        return { isOpen: () => !closed, close: async () => { closed++; }, readSubscriptionPage: async () => ++reads === 1 ?
          { authenticated: false, blocked: 'challenge', windows: [] } : { authenticated: true, windows: [{ label: 'Semaine', remaining: 0, resetAt: null }] } };
      },
    });
    await controller.read(id, { background: true, interactive: true });
    assert.ok(updates.includes('waiting')); assert.equal(saved, 1); assert.equal(closed, 1);
    await controller.closeAll();
  }
  let closed = 0, failure;
  const controller = createSubscriptionController({ dataDir: 'test-only', wait: async () => {}, onChange() {}, deleteProfile: async () => {}, onResult: async () => assert.fail('No authenticated session'),
    onFailure: async (_id, message) => { failure = message; }, openBrowser: async () => ({ isOpen: () => true, phase: () => 'verifying',
      readSubscriptionPage: async () => ({ authenticated: false, blocked: 'challenge', windows: [] }), close: async () => { closed++; } }) });
  await controller.open('grok');
  await assert.rejects(controller.read('grok', { interactive: true }), { code: 'ACCOUNT_BROWSER_CHECK' });
  assert.equal(closed, 1); assert.match(failure, /vérification de sécurité/);
  await controller.closeAll();
});

test('Background Grok refresh waits for its known Bot limit; a shared pool switch can drop the separate limit', async () => {
  const weekly = { label: 'Semaine', remaining: 92, resetAt: null };
  const bot = { label: 'Grok Bot · Semaine', remaining: 100, resetAt: null };
  let reads = 0, saved;
  const controller = createSubscriptionController({ dataDir: 'fixture', wait: async () => {}, onChange() {}, deleteProfile: async () => {},
    getPreviousSnapshot: () => ({ usageKind: 'supergrok-legacy', quotaWindows: [weekly, bot] }),
    onResult: async (_id, snapshot) => { saved = snapshot; },
    openBrowser: async () => ({ isOpen: () => true, close: async () => {}, readSubscriptionPage: async () => ({ authenticated: true,
      usageKind: reads >= 2 ? 'x-subscription-shared' : 'supergrok-legacy', windows: ++reads === 1 || reads > 2 ? [weekly] : [weekly, bot] }) }),
  });
  try {
    await controller.read('grok', { background: true });
    assert.equal(reads, 2);
    assert.deepEqual(saved.quotaWindows.map(w => w.label), ['Semaine', 'Grok Bot · Semaine']);
    await controller.read('grok', { background: true });
    assert.equal(reads, 3);
    assert.equal(saved.usageKind, 'x-subscription-shared');
    assert.equal(saved.quotaWindows.length, 1);
  } finally { await controller.closeAll(); }
});

test('An automatic refresh with valid authentication and missing quotas retains the session and closes its temporary browser', async () => {
  let closed = 0, result;
  const controller = createSubscriptionController({ dataDir: 'test-only', wait: async () => {}, onChange() {}, deleteProfile: async () => {},
    onResult: async (_id, snapshot, message) => { result = { snapshot, message }; }, openBrowser: async () => ({ isOpen: () => true,
      readSubscriptionPage: async () => ({ authenticated: true, windows: [] }), close: async () => { closed++; } }) });
  await controller.read('grok', { background: true, automatic: true });
  assert.equal(result.snapshot, null); assert.match(result.message, /quota indisponible/); assert.equal(closed, 1);
  await controller.closeAll();
});
test('Sessions open interactively, refresh without a window, close after reading and disconnect independently', async () => {
  const h = harness();
  try {
    for (const id of Object.keys(accounts)) { await h.controller.open(id); await h.controller.read(id); }
    assert.equal(h.reads.length, Object.keys(accounts).length);
    assert.equal(h.closed.length, Object.keys(accounts).length);
    assert.ok(h.opens.every(o => o.headless === false));
    await h.controller.read('openai', { background: true });
    assert.deepEqual(h.opens.at(-1), { id: 'openai', headless: true });
    await h.controller.disconnect('zai');
    assert.deepEqual(h.deleted, ['zai']);
    assert.equal(h.controller.info('openai').status, 'connected');
  } finally { await h.controller.closeAll(); }
});

test('Claude human verification keeps Chrome open until the usage page becomes readable', async () => {
  let reads = 0, closes = 0, options, saved;
  const updates = [];
  const controller = createSubscriptionController({ dataDir: 'test-only', onChange() { updates.push(controller.info('claude').status); },
    deleteProfile: async () => {}, onResult: async (_id, snapshot) => { saved = snapshot; },
    openBrowser: async (_dir, id, headless, input) => {
      assert.equal(id, 'claude'); assert.equal(headless, true); options = input;
      return { isOpen: () => closes === 0, close: async () => { closes++; }, readSubscriptionPage: async () => {
        assert.equal(closes, 0); reads++;
        return reads === 1 ? { authenticated: false, blocked: 'challenge', windows: [] } :
          { authenticated: true, windows: [{ label: '5 heures', remaining: 88, resetAt: null }, { label: 'Semaine', remaining: 91, resetAt: null }] };
      } };
    },
  });
  try {
    await controller.read('claude', { background: true, interactive: true });
    assert.equal(options.interactive, true);
    assert.deepEqual(saved.quotaWindows.map(w => w.remaining), [88, 91]);
    assert.ok(updates.includes('waiting'));
    assert.equal(reads, 2); assert.equal(closes, 1);
  } finally { await controller.closeAll(); }
});
test('Unauthenticated verification never saves; missing usage saves only after explicit verification and retains no invented snapshot', async () => {
  const h = harness();
  try {
    await h.controller.open('zai');
    h.result({ authenticated: false, windows: [] });
    await assert.rejects(h.controller.read('zai'), { code: 'ACCOUNT_SIGNIN' });
    assert.equal(h.reads.length, 0);
    h.result({ authenticated: true, windows: [] });
    await h.controller.read('zai', { automatic: true });
    assert.equal(h.reads.length, 0);
    await h.controller.read('zai');
    assert.deepEqual(h.reads, [{ id: 'zai', snapshot: null }]);
    assert.match(h.controller.info('zai').message, /quota indisponible/);
  } finally { await h.controller.closeAll(); }
});
test('Concurrent opening/verification creates one browser and one measurement; disconnect waits for verification', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const c = createSubscriptionController({ dataDir: 'test-only', onChange() {}, onResult: async () => events.push('saved'), deleteProfile: async () => events.push('deleted'),
    openBrowser: async () => { events.push('opened'); return { isOpen: () => true, close: async () => events.push('closed'), readSubscriptionPage: async () => { await gate; return { authenticated: true, windows: [{ label: 'Semaine', remaining: 20, resetAt: null }] }; } }; },
  });
  await Promise.all([c.open('grok'), c.open('grok')]);
  const a = c.read('grok'), b = c.read('grok'), d = c.disconnect('grok');
  release(); const result=await Promise.allSettled([a, b, d]);
  assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'rejected');assert.equal(result[2].status,'fulfilled');
  assert.deepEqual(events, ['opened', 'closed', 'deleted']);
  await c.closeAll();
});

// ---------------------------------------------------------------------------
// Courses entre rafraîchissement de fond et vérification interactive.
// ---------------------------------------------------------------------------
const nextTick = () => new Promise(resolve => setImmediate(resolve));

test('Une vérification interactive n’est jamais servie par un travail de fond en cours', async () => {
  let releaseBackground;
  const backgroundGate = new Promise(resolve => { releaseBackground = resolve; });
  const opens = [], saved = [];
  let activeBrowsers = 0, maxBrowsers = 0;
  const controller = createSubscriptionController({ dataDir: 'test-only', wait: async () => {}, onChange() {}, deleteProfile: async () => {},
    onResult: async (_id, snapshot) => saved.push(snapshot?.quotaRemaining ?? null),
    openBrowser: async (_dir, _id, headless, options = {}) => {
      const interactive = options.interactive === true;
      opens.push({ headless, interactive });
      activeBrowsers++; maxBrowsers = Math.max(maxBrowsers, activeBrowsers);
      let open = true;
      return {
        isOpen: () => open,
        close: async () => { if (open) { open = false; activeBrowsers--; } },
        readSubscriptionPage: async () => {
          if (!interactive) { await backgroundGate; return { authenticated: true, windows: [{ label: 'Semaine', remaining: 10, resetAt: null }] }; }
          return { authenticated: true, windows: [{ label: 'Semaine', remaining: 90, resetAt: null }] };
        },
      };
    } });
  try {
    const background = controller.read('grok', { background: true });
    await nextTick();
    assert.deepEqual(opens, [{ headless: true, interactive: false }]);
    let interactiveDone = false;
    const interactive = controller.read('grok', { background: true, interactive: true }).then(snapshot => { interactiveDone = true; return snapshot; });
    await nextTick();
    // La demande interactive n'est pas servie par le relevé de fond : elle attend.
    assert.equal(interactiveDone, false);
    assert.deepEqual(opens, [{ headless: true, interactive: false }], 'aucun second Chrome tant que le fond tourne');
    releaseBackground();
    await background;
    const snapshot = await interactive;
    assert.equal(interactiveDone, true);
    assert.equal(snapshot.quotaRemaining, 90, 'le relevé interactif doit être réellement relu');
    assert.equal(maxBrowsers, 1, 'jamais deux navigateurs pour le même profil');
    assert.deepEqual(opens, [{ headless: true, interactive: false }, { headless: true, interactive: true }]);
    assert.deepEqual(saved, [10, 90]);
  } finally { await controller.closeAll(); }
});

test('Deux clics « Vérifier maintenant » ne lancent qu’une passe interactive, rejointe par le fond', async () => {
  let releaseBackground, releaseInteractive;
  const backgroundGate = new Promise(resolve => { releaseBackground = resolve; });
  const interactiveGate = new Promise(resolve => { releaseInteractive = resolve; });
  const opens = [];
  const controller = createSubscriptionController({ dataDir: 'test-only', wait: async () => {}, onChange() {}, deleteProfile: async () => {}, onResult: async () => {},
    openBrowser: async (_dir, _id, headless, options = {}) => {
      const interactive = options.interactive === true;
      opens.push({ headless, interactive });
      let open = true;
      return { isOpen: () => open, close: async () => { open = false; }, readSubscriptionPage: async () => {
        if (!interactive) { await backgroundGate; return { authenticated: true, windows: [{ label: 'Semaine', remaining: 10, resetAt: null }] }; }
        await interactiveGate;
        return { authenticated: true, windows: [{ label: 'Semaine', remaining: 90, resetAt: null }] };
      } };
    } });
  try {
    const background = controller.read('grok', { background: true });
    await nextTick();
    const first = controller.read('grok', { background: true, interactive: true });
    const second = controller.read('grok', { background: true, interactive: true });
    assert.equal(opens.length, 1);
    releaseBackground();
    await background;
    await nextTick();
    assert.deepEqual(opens, [{ headless: true, interactive: false }, { headless: true, interactive: true }], 'une seule passe interactive pour deux clics');
    // Un rafraîchissement de fond arrivé pendant la vérification la rejoint.
    const joined = controller.read('grok', { background: true });
    releaseInteractive();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.quotaRemaining, 90);
    assert.equal(b.quotaRemaining, 90);
    assert.equal((await joined).quotaRemaining, 90);
    assert.equal(opens.length, 2, 'aucun troisième navigateur');
  } finally { await controller.closeAll(); }
});

test('Des rafraîchissements simultanés ne lancent qu’un navigateur par fournisseur', async () => {
  let launches = 0, active = 0, maxActive = 0;
  const controller = createSubscriptionController({ dataDir: 'test-only', wait: async () => {}, onChange() {}, deleteProfile: async () => {}, onResult: async () => {},
    openBrowser: async () => {
      launches++; active++; maxActive = Math.max(maxActive, active);
      let open = true;
      return { isOpen: () => open, close: async () => { if (open) { open = false; active--; } },
        readSubscriptionPage: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { authenticated: true, windows: [{ label: 'Semaine', remaining: 55, resetAt: null }] }; } };
    } });
  try {
    const results = await Promise.all([1, 2, 3].map(() => controller.read('grok', { background: true })));
    assert.equal(launches, 1, 'une seule mesure pour des demandes simultanées');
    assert.equal(maxActive, 1);
    assert.ok(results.every(snapshot => snapshot?.quotaRemaining === 55));
  } finally { await controller.closeAll(); }
});

test('Une vérification interactive reste possible après l’échec du fond qui l’a précédée', async () => {
  let attempts = 0;
  const statuses = [];
  const controller = createSubscriptionController({ dataDir: 'test-only', wait: async () => {}, onChange() { statuses.push(controller.info('zai').status); },
    deleteProfile: async () => {}, onResult: async () => {}, onFailure: async () => {},
    openBrowser: async (_dir, _id, _headless, options = {}) => {
      const interactive = options.interactive === true;
      attempts++;
      let open = true;
      return { isOpen: () => open, close: async () => { open = false; }, readSubscriptionPage: async () => {
        if (!interactive) throw Object.assign(new Error('Session Z.ai absente ou expirée.'), { code: 'ACCOUNT_SIGNIN' });
        return { authenticated: true, windows: [{ label: 'Semaine', remaining: 33, resetAt: null }] };
      } };
    } });
  try {
    const background = controller.read('zai', { background: true }).catch(() => {});
    const interactive = controller.read('zai', { background: true, interactive: true });
    await background;
    const snapshot = await interactive;
    assert.equal(snapshot.quotaRemaining, 33);
    assert.equal(attempts, 2, 'le fond a échoué puis l’interactif a relancé une passe');
    assert.ok(statuses.includes('error'));
  } finally { await controller.closeAll(); }
});

test('Ouvrir la connexion pendant une file interactive ne bloque pas et n’ouvre que deux navigateurs', async () => {
  const opens = [];
  let releaseBackground;
  const backgroundGate = new Promise(resolve => { releaseBackground = resolve; });
  const controller = createSubscriptionController({ dataDir: 'test-only', wait: async () => {}, onChange() {}, deleteProfile: async () => {}, onResult: async () => {},
    openBrowser: async (_dir, _id, headless) => {
      opens.push({ headless });
      let open = true;
      return {
        isOpen: () => open,
        phase: () => 'login',
        onReady() {},
        close: async () => { open = false; },
        readSubscriptionPage: async ({ signal, interactive: readingInteractive } = {}) => {
          if (!readingInteractive) {
            if (signal?.aborted) throw new Error('annulé');
            await new Promise((resolve, reject) => {
              backgroundGate.then(resolve);
              signal?.addEventListener('abort', () => reject(new Error('annulé')), { once: true });
            });
            return { authenticated: false, windows: [] };
          }
          return { authenticated: true, windows: [{ label: 'Semaine', remaining: 77, resetAt: null }] };
        },
      };
    } });
  try {
    controller.read('grok', { background: true }).catch(() => {});
    await nextTick();
    const interactive = controller.read('grok', { background: true, interactive: true });
    const opened = await controller.open('grok');
    assert.equal(opened, true);
    releaseBackground();
    const snapshot = await Promise.race([interactive, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('interblocage')), 3000))]);
    assert.equal(snapshot.quotaRemaining, 77);
    assert.deepEqual(opens, [{ headless: true }, { headless: false }]);
    assert.equal(opens.filter(entry => entry.headless === false).length, 1);
  } finally { await controller.closeAll(); }
});

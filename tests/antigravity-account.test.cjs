const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseAntigravityQuota,fetchAntigravityQuota,discoverServers,DISCOVERY_COMMAND}=require('../lib/antigravity-account.cjs');
const {addAntigravity}=require('../lib/migrations.cjs');
const {createSeed}=require('../lib/seed.cjs');
function response(){return {response:{groups:[{displayName:'Gemini Models',buckets:[{bucketId:'gemini-weekly',window:'weekly',remainingFraction:.9779,resetTime:'2026-09-10T23:06:43Z'},{bucketId:'gemini-5h',window:'5h',remainingFraction:.9351,resetTime:'2026-09-07T18:32:42Z'}]},{displayName:'Claude and GPT models',buckets:[{bucketId:'3p-weekly',window:'weekly',remainingFraction:1},{bucketId:'3p-5h',window:'5h',remainingFraction:1}]}]}};}
test('Antigravity reads four distinct quotas and matches desktop rounding, without interpreting credits as dollars',()=>{
 const data=response();data.response.email='private@example.test';data.response.credits=500;
 const snapshot=parseAntigravityQuota(data);
 assert.equal(snapshot.quotaRemaining,94);assert.equal(snapshot.quotaWindows.length,4);
 assert.deepEqual(snapshot.quotaWindows.map(w=>w.remaining),[98,94,100,100]);
 assert.equal(snapshot.resetAt,'2026-09-07T18:32:42.000Z');assert.deepEqual(snapshot.balances,[]);
 assert.ok(!JSON.stringify(snapshot).includes('private'));assert.ok(!JSON.stringify(snapshot).includes('500'));
});
test('Antigravity reads the installed Gemini 4 Argon weekly bucket',()=>{
 const data=response();
 data.response.groups.push({displayName:'Gemini 4 Argon',buckets:[{bucketId:'gemini-argon-wtu-weekly',window:'weekly',remainingFraction:.88,resetTime:'2026-10-24T12:00:00Z'}]});
 const snapshot=parseAntigravityQuota(data);
 const argon=snapshot.quotaWindows.find(w=>w.label==='Gemini 4 Argon · Semaine');
 assert.deepEqual(argon,{label:'Gemini 4 Argon · Semaine',remaining:88,resetAt:'2026-10-24T12:00:00.000Z'});
 assert.equal(snapshot.quotaWindows.length,5);
 assert.equal(snapshot.quotaRemaining,88);
 assert.equal(snapshot.quotaLabel,'Antigravity · Gemini 4 Argon · Semaine');
});
test('Unknown, missing, disabled and conflicting buckets never fabricate 100% remaining',()=>{
 for(const value of [null,undefined,NaN,Infinity,-.1,1.1,'0.5']) {const data=response();data.response.groups[0].buckets[0].remainingFraction=value;assert.throws(()=>parseAntigravityQuota(data));}
 assert.throws(()=>parseAntigravityQuota({response:{groups:[]}}));
 const data=response();data.response.groups[0].buckets[0].disabled=true;assert.equal(parseAntigravityQuota(data).quotaWindows.length,3);
 data.response.groups[1].buckets.push(data.response.groups[1].buckets[0]);assert.throws(()=>parseAntigravityQuota(data),/contradictoires/);
 const zero=response();zero.response.groups[0].buckets[0].remainingFraction=0;assert.equal(parseAntigravityQuota(zero).quotaRemaining,0);
});
test('A known bucket whose window changed is degraded with a warning instead of failing the reading',()=>{
 const data=response();
 data.response.groups.push({displayName:'Unrecognized model group',buckets:[{bucketId:'unknown-weekly',window:'monthly',remainingFraction:1.5}]});
 assert.equal(parseAntigravityQuota(data).quotaWindows.length,4);
 // A provider-side window change on a known bucket must not hide the other quotas.
 const changedWindow=response();changedWindow.response.groups.push({displayName:'Gemini 4 Argon',buckets:[{bucketId:'gemini-argon-wtu-weekly',window:'5h',remainingFraction:.5}]});
 const degraded=parseAntigravityQuota(changedWindow);
 assert.equal(degraded.quotaWindows.length,4);
 assert.equal(degraded.quotaWindows.some(w=>w.label==='Gemini 4 Argon · Semaine'),false);
 assert.equal(degraded.warnings.length,1);
 assert.match(degraded.warnings[0],/Gemini 4 Argon/);
 // A malformed amount or an ambiguous date on a known bucket is still a hard error.
 for(const value of [NaN,Infinity,-.1,1.1,'0.5']) {
  const invalidFraction=response();invalidFraction.response.groups.push({displayName:'Gemini 4 Argon',buckets:[{bucketId:'gemini-argon-wtu-weekly',window:'weekly',remainingFraction:value}]});
  assert.throws(()=>parseAntigravityQuota(invalidFraction),/Quota Antigravity invalide/);
 }
 const invalidReset=response();invalidReset.response.groups.push({displayName:'Gemini 4 Argon',buckets:[{bucketId:'gemini-argon-wtu-weekly',window:'weekly',remainingFraction:.5,resetTime:'not-a-date'}]});
 assert.throws(()=>parseAntigravityQuota(invalidReset),/Date de quota Antigravity invalide/);
 // ISO dates without a timezone are ambiguous and must be refused.
 const noTimezone=response();noTimezone.response.groups.push({displayName:'Gemini 4 Argon',buckets:[{bucketId:'gemini-argon-wtu-weekly',window:'weekly',remainingFraction:.5,resetTime:'2026-10-24T12:00:00'}]});
 assert.throws(()=>parseAntigravityQuota(noTimezone),/fuseau/);
 const duplicate=response();duplicate.response.groups.push({displayName:'Gemini 4 Argon',buckets:[{bucketId:'gemini-argon-wtu-weekly',window:'weekly',remainingFraction:.5}]});
 duplicate.response.groups[1].buckets.push({bucketId:'gemini-argon-wtu-weekly',window:'weekly',remainingFraction:.5});
 assert.throws(()=>parseAntigravityQuota(duplicate),/Quotas Antigravity contradictoires/);
});
test('Discovery forces UTF-8, resolves listeners by PID and tolerates scalar ports',async()=>{
 assert.match(DISCOVERY_COMMAND,/\$OutputEncoding/);
 assert.match(DISCOVERY_COMMAND,/Encoding\]::UTF8/);
 assert.match(DISCOVERY_COMMAND,/ExecutablePath/);
 // Regression: a global `Get-NetTCPConnection -State Listen` misses listeners
 // whose OwningProcess is reported as 0 on some Windows builds.
 assert.doesNotMatch(DISCOVERY_COMMAND,/Get-NetTCPConnection -State Listen/);
 assert.match(DISCOVERY_COMMAND,/-OwningProcess \$processId/);
 // Listener detection must not depend on the textual state only.
 assert.match(DISCOVERY_COMMAND,/RemotePort -eq 0/);
 // Fallbacks for environments where the NetTCPConnection cmdlet fails.
 assert.match(DISCOVERY_COMMAND,/MSFT_NetTCPConnection/);
 assert.match(DISCOVERY_COMMAND,/netstat -ano/);
 const servers=await discoverServers({run:async()=>JSON.stringify({args:'--csrf_token=abcdefghijklmnop1234',ports:9222})});
 assert.deepEqual(servers,[{port:9222,csrf:'abcdefghijklmnop1234'}]);
 const many=await discoverServers({run:async()=>JSON.stringify([{args:'--csrf_token abcdefghijklmnop1234',ports:[9222,9223,9223,0,70000]},{args:'no-token',ports:[9224]},null])});
 assert.deepEqual(many,[{port:9222,csrf:'abcdefghijklmnop1234'},{port:9223,csrf:'abcdefghijklmnop1234'}]);
 // Ports are resolved per PID: fixture of a real per-PID listener output.
 const byPid=await discoverServers({run:async()=>JSON.stringify({args:'--csrf_token bc938a61-e2fc-49cf-b70d-12d842ba8d9f --https_server_port 0',ports:[53733,49985,61570]})});
 assert.deepEqual(byPid.map(server=>server.port),[53733,49985,61570]);
 await assert.rejects(discoverServers({run:async()=>{throw new Error('private token')}}),error=>!error.message.includes('private token')&&error.code==='ANTIGRAVITY_DISCOVERY_FAILED');
 await assert.rejects(discoverServers({run:async()=>'not json'}),/ne peut pas être détecté/);
});
test('Discovery distinguishes a missing service from a service without readable ports',async()=>{
 const missing=await discoverServers({run:async()=>'[]'}).then(()=>null,error=>error);
 assert.equal(missing&&missing.code,'ANTIGRAVITY_NOT_RUNNING');
 assert.match(missing.message,/introuvable/);
 const noPorts=await discoverServers({run:async()=>JSON.stringify({args:'--csrf_token=abcdefghijklmnop1234',ports:[]})}).then(()=>null,error=>error);
 assert.equal(noPorts&&noPorts.code,'ANTIGRAVITY_NO_PORTS');
 assert.match(noPorts.message,/ports locaux/);
 assert.equal(JSON.stringify(noPorts.message).includes('abcdefghijklmnop1234'),false);
 const noCsrf=await discoverServers({run:async()=>JSON.stringify({args:'no-token',ports:[9222]})}).then(()=>null,error=>error);
 assert.equal(noCsrf&&noCsrf.code,'ANTIGRAVITY_NO_PORTS');
});
test('Local discovery handles a closed app and skips non-HTTP service ports without exposing local tokens',async()=>{
 await assert.rejects(fetchAntigravityQuota({discover:async()=>[]}),/Aucune CLI/);
 let calls=0;
 const snapshot=await fetchAntigravityQuota({discover:async()=>[{port:1},{port:2}],request:async()=>{if(++calls===1)throw new Error('private token');return response();}});
 assert.equal(snapshot.quotaRemaining,94);assert.equal(calls,2);
 await assert.rejects(fetchAntigravityQuota({discover:async()=>[{}],request:async()=>{throw new Error('private token')}}),error=>!error.message.includes('private token'));
});
test('Adding Antigravity preserves Gemini web sessions, existing billing and historical readings',()=>{
 const state=createSeed();state.providers=state.providers.filter(p=>p.id!=='antigravity');
 state.providers.push({id:'gemini',type:'subscription'});const gemini=state.providers.find(p=>p.id==='gemini');Object.assign(gemini,{name:'Gemini',accountSession:{kind:'subscription-browser'},amount:109.99,snapshot:{quotaRemaining:100}});
 state.history.push({providerId:'gemini',quotaRemaining:100});const before=structuredClone(state);
 const result=addAntigravity(state);assert.equal(result.changed,true);assert.equal(result.state.providers.length,10);
 assert.deepEqual(result.state.providers.find(p=>p.id==='gemini'),{...gemini,name:'Gemini web'});
 assert.equal(result.state.providers.find(p=>p.id==='antigravity').snapshot,null);
 assert.deepEqual(result.state.history,before.history);assert.deepEqual(state,before);assert.equal(addAntigravity(result.state).changed,false);
});

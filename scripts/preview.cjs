const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createSeed}=require('../lib/seed.cjs');
const {summary}=require('../lib/domain.cjs');
const {connectionInfo}=require('../lib/provider-catalog.cjs');
const providerAssets=require('../assets/providers/sources.json');
const providerExtensions={claude:'ico',antigravity:'ico',deepseek:'ico',ollama:'png',openrouter:'png'};
const routes={'/':'renderer/index.html','/app.js':'renderer/app.js','/styles.css':'renderer/styles.css','/theme.css':'renderer/theme.css','/theme-init.js':'renderer/theme-init.js','/assets/icon.png':'assets/icon.png'};
routes['/lib/resource-levels.js']='lib/resource-levels.js';
// La fonctionnalité de recommandation de modèle a été retirée en 0.3.4 :
// plus de routes strategy-ui/usage-strategy dans l'aperçu.
Object.assign(routes, {'/lib/quota-resets.js':'lib/quota-resets.js','/reset-ui.js':'renderer/reset-ui.js'});
// Renderer refonte 0.3.0 : les vues et helpers sont chargés avant app.js.
// Les vues sont découpées en quatre fichiers (coquille, cartes, pages, widget).
Object.assign(routes, {'/ui-core.js':'renderer/ui-core.js','/views-shell.js':'renderer/views-shell.js','/views-cards.js':'renderer/views-cards.js','/views-pages.js':'renderer/views-pages.js','/views-quick.js':'renderer/views-quick.js'});
// Police empaquetée (aucun téléchargement au lancement).
routes['/assets/fonts/InterVariable.woff2'] = 'assets/fonts/InterVariable.woff2';
routes['/assets/fonts/SoraVariable.woff2'] = 'assets/fonts/SoraVariable.woff2';
routes['/assets/brand/lasmium-mark.svg'] = 'assets/brand/lasmium-mark.svg';
for(const id of Object.keys(providerAssets)){const file=`assets/providers/${id}.${providerExtensions[id]||'svg'}`;routes['/'+file]=file;}
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/preview-state'){
    const state=createSeed();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...state,providers:state.providers.map(p=>({...p,connector:connectionInfo(p.id)})),desktop:false,summary:summary(state.providers)}));return;
  }
  const file=routes[url.pathname];if(!file){res.writeHead(404);res.end('Not found');return;}
  try{const data=await fs.readFile(path.join(__dirname,'..',file));res.setHeader('Content-Type',{'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8','png':'image/png','svg':'image/svg+xml','ico':'image/x-icon','woff2':'font/woff2'}[file.split('.').at(-1)]);res.end(data);}catch{res.writeHead(500);res.end('Preview unavailable');}
}).listen(4317,'127.0.0.1',()=>console.log('Aperçu : http://127.0.0.1:4317'));

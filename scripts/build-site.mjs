import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {build} from 'vite';

// Retain published hashed files across releases, including tabs opened before a deployment.
const archive=path.resolve('build/asset-history'),indexFile=path.join(archive,'index.json');
fs.mkdirSync(archive,{recursive:true});
let history=fs.existsSync(indexFile)?JSON.parse(fs.readFileSync(indexFile,'utf8')):{};
function assets(dir){return fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>/^[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(n)):[];}
for(const name of assets('dist/assets')){
  fs.copyFileSync(path.join('dist/assets',name),path.join(archive,name));
  history[name]??=Date.now();
}
await build();
const manifest=JSON.parse(fs.readFileSync('dist/.vite/manifest.json','utf8'));
const entry=manifest['web/trade.ts'];
if(!entry?.isEntry||!entry.file)throw Error('Trading entry missing');
const styles=new Set(),visited=new Set();
function collect(key){if(visited.has(key))return;visited.add(key);const item=manifest[key];if(!item)return;for(const css of item.css||[])styles.add('/'+css);for(const child of item.imports||[])collect(child);}
collect('web/trade.ts');
const fingerprint=crypto.createHash('sha256').update(JSON.stringify(entry)).update(fs.readFileSync('dist/'+entry.file)).digest('hex');
fs.writeFileSync('dist/app.json',JSON.stringify({build:fingerprint,entry:'/'+entry.file,styles:[...styles]})+'\n');
const script=fs.readFileSync('web/startup.js','utf8'),css=fs.readFileSync('web/startup.css','utf8');
new vm.Script(script);
let html=fs.readFileSync('dist/index.html','utf8');
if(!html.includes('<!-- TYW_STARTUP -->'))throw Error('Startup marker missing');
html=html.replace('<!-- TYW_STARTUP -->',()=>`<style>${css}</style><script>${script}</script>`);
fs.writeFileSync('dist/index.html',html);
if(html.match(/<script>([\s\S]*?)<\/script>/)?.[1]!==script)throw Error('Startup content changed during HTML assembly');
const hash=text=>`'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;
fs.writeFileSync('src/boot-policy.ts',`// Generated from the exact startup content in the deployed HTML.\nexport const BOOT_SCRIPT_HASH=${JSON.stringify(hash(script))};\nexport const BOOT_STYLE_HASH=${JSON.stringify(hash(css))};\n`);
const current=new Set(assets('dist/assets')),now=Date.now();
for(const name of current){fs.copyFileSync(path.join('dist/assets',name),path.join(archive,name));history[name]=now;}
const older=Object.entries(history).filter(([name])=>!current.has(name)).sort((a,b)=>b[1]-a[1]);
let retained=0;
for(const [name,lastSeen]of older){
  if(!/^[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(name))throw Error('Invalid archive filename');
  if(now-lastSeen<30*86400000&&retained<4096){fs.copyFileSync(path.join(archive,name),path.join('dist/assets',name));retained++;}
  else {const file=path.resolve(archive,name);if(path.dirname(file)!==archive)throw Error('Archive path outside build directory');if(fs.existsSync(file))fs.unlinkSync(file);delete history[name];}
}
fs.writeFileSync(indexFile,JSON.stringify(history));
console.log(JSON.stringify({build:fingerprint,currentAssets:current.size,previousAssetsRetained:retained,inlineStartup:true}));

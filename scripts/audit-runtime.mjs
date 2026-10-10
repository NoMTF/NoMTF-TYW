import fs from'node:fs';import path from'node:path';import {spawnSync}from'node:child_process';
const dir=path.resolve('.qa/runtime-audit');fs.mkdirSync(dir,{recursive:true});const p=JSON.parse(fs.readFileSync('package.json'));
fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'nomtf-runtime-audit',version:'1.0.0',private:true,dependencies:p.dependencies},null,2));
const npm=path.resolve(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const installed=spawnSync(process.execPath,[npm,'install','--package-lock-only','--ignore-scripts','--no-fund','--no-audit'],{cwd:dir,encoding:'utf8'});if(installed.status!==0){console.error('audit_resolution_failed');process.exit(1);}
const result=spawnSync(process.execPath,[npm,'audit','--json','--omit=dev'],{cwd:dir,encoding:'utf8'});
const data=JSON.parse(result.stdout);fs.writeFileSync('reports/runtime-dependency-audit.json',JSON.stringify({at:new Date().toISOString(),scope:'Production dependency closure only; dev Ganache bundled dependencies are excluded from deployed browser and Worker',dependencies:p.dependencies,metadata:data.metadata,vulnerabilities:data.vulnerabilities},null,2));console.log(JSON.stringify(data.metadata.vulnerabilities));process.exitCode=result.status;

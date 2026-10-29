import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'yaml';
import {createArchive} from '../dist/bundles/archive.js';
import {makeManifest} from '../dist/bundles/manifest.js';
import {DockerRunner} from '../dist/docker/runner.js';
import {upProduction, downProduction, statusProduction} from '../dist/prod/deploy.js';
import {logger} from '../dist/logger.js';

for (const mode of ['plugin-v2', 'standalone-v2', 'standalone-v1']) {
 test(`production deployment supports ${mode}`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dockpack-compose-compat-'));
  const originalPath = process.env.PATH, originalData = process.env.XDG_DATA_HOME;
  try {
   const bin = path.join(root, 'bin'), stage = path.join(root, 'stage'), report = path.join(root, 'report.json');
   await mkdir(bin); await mkdir(path.join(stage, 'compose'), {recursive:true}); await mkdir(path.join(stage, 'images'));
   await writeFile(path.join(stage, 'images', 'images.tar'), 'fixture');
   await writeFile(path.join(stage, 'compose', 'compose.yaml'), 'name: compat\nservices:\n  app:\n    image: example/app:offline\n    pull_policy: never\n');
   const bundle = path.join(root, 'prod.tar.gz');
   await createArchive(stage, bundle, makeManifest({bundle_kind:'prod', dockpack_version:'0.10.0',project_name:'compat',target_platform:'linux/arm64',images:['example/app:offline'],services:['app'],dependencies:{},required_config:['DOCUMENT_API_URL']}));
   const script = `#!${process.execPath}\nconst fs=require('node:fs'); const a=process.argv.slice(2); const plugin=process.argv[1].endsWith('/docker'); if(a.includes('version')) { if(plugin && ${JSON.stringify(mode)}!=='plugin-v2') process.exit(1); console.log(${JSON.stringify(mode === 'standalone-v1' ? 'docker-compose version 1.29.2' : 'Docker Compose version v2.30.0')}); process.exit(0); } fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({args:a,config:fs.readFileSync(a[a.indexOf('-f')+1],'utf8')}));\n`;
   for (const name of ['docker','docker-compose']) await writeFile(path.join(bin,name), script, {mode:0o755});
   process.env.PATH=bin+path.delimiter+originalPath; process.env.XDG_DATA_HOME=path.join(root,'data');
   for (const name of ['info','success']) t.mock.method(logger,name,()=>{});
   t.mock.method(DockerRunner.prototype,'available',()=>true);
   t.mock.method(DockerRunner.prototype,'platform',()=>({id:'linux/arm64'}));
   t.mock.method(DockerRunner.prototype,'load',()=>{});
   const hasImage=t.mock.method(DockerRunner.prototype,'hasImage',()=>true);
   t.mock.method(DockerRunner.prototype,'imagePlatform',()=> 'linux/arm64');
   const externalEnv=path.join(root,'.env');
   await writeFile(externalEnv,'DOCUMENT_API_URL=http://backend:8000\n');
   await upProduction(bundle);
   const result=JSON.parse(await readFile(report,'utf8'));
   assert.ok(result.args.includes('--no-build'));
   assert.equal(result.args[result.args.indexOf('--env-file')+1],externalEnv);
   const customEnv=path.join(root,'production.env');
   await writeFile(customEnv,'DOCUMENT_API_URL=http://other-backend:8000\n');
   await upProduction(bundle,customEnv);
   const explicit=JSON.parse(await readFile(report,'utf8'));
   assert.equal(explicit.args[explicit.args.indexOf('--env-file')+1],customEnv);
   await assert.rejects(upProduction(bundle,path.join(root,'absent.env')),/Environment file not found/);
   assert.equal(result.args.includes('--pull'),mode!=='standalone-v1');
   const model=parse(result.config);
   assert.equal(model.name,mode==='standalone-v1'?undefined:'compat');
   assert.equal(model.services.app.pull_policy,mode==='standalone-v1'?undefined:'never');
   const configFile=result.args[result.args.indexOf('-f')+1];
   if(mode==='standalone-v1') assert.match(await readFile(path.join(path.dirname(configFile),'compose.yaml'),'utf8'),/pull_policy: never/);
   await downProduction(bundle);
   assert.equal(JSON.parse(await readFile(report,'utf8')).args.includes(configFile),true);
   t.mock.method(console,'log',()=>{});
   await statusProduction(bundle);
   assert.equal(JSON.parse(await readFile(report,'utf8')).args.includes(configFile),true);
   await rm(report);
   await writeFile(externalEnv,'DOCUMENT_API_URL=\n');
   await assert.rejects(upProduction(bundle),/Set required production variables/);
   await assert.rejects(readFile(report),{code:'ENOENT'});
   await writeFile(externalEnv,'DOCUMENT_API_URL=http://backend:8000\n');
   hasImage.mock.mockImplementation(()=>false);
   await assert.rejects(upProduction(bundle),/image import is incomplete/);
   await assert.rejects(readFile(report),{code:'ENOENT'});
   if(mode==='standalone-v1') {
    hasImage.mock.mockImplementation(()=>true);
    await writeFile(path.join(path.dirname(configFile),'compose.yaml'),'services:\n  app:\n    image: example/not-in-bundle:latest\n    pull_policy: always\n');
    await assert.rejects(upProduction(bundle),/Cannot start 'app' offline/);
    await assert.rejects(readFile(report),{code:'ENOENT'});
   }
  } finally {
   process.env.PATH=originalPath;
   if(originalData===undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME=originalData;
   await rm(root,{recursive:true,force:true});
  }
 });
}

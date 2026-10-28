import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'yaml';
import {DockerRunner} from '../dist/docker/runner.js';
import {buildProductionBundle} from '../dist/prod/build.js';
import {createArchive, extractArchive} from '../dist/bundles/archive.js';
import {makeManifest} from '../dist/bundles/manifest.js';
import {sha256Files} from '../dist/dev/dependencies.js';
import {detectComposeCommand} from '../dist/compose/inspect.js';
import {logger} from '../dist/logger.js';

for (const compose of [false, true]) {
 test(`automatic frontend injects runtime backend configuration (${compose ? 'existing Compose' : 'generated Compose'})`, {skip: compose && !detectComposeCommand()}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dockpack-frontend-prod-'));
  try {
   await writeFile(path.join(root, 'package.json'), JSON.stringify({name:'frontend',version:'1.0.0',scripts:{build:'vite build'},devDependencies:{vite:'1.0.0'}}));
   await writeFile(path.join(root, 'package-lock.json'), '{}');
   await writeFile(path.join(root, '.dockpack.yaml'), `project:\n  name: frontend\n  ecosystems: [node]\nruntime:\n  node_version: "22"\napplication:\n  port: 8080\ntarget:\n  dev_platform: linux/amd64\n  production_platform: linux/amd64\ncompose:\n  files: ${compose ? '[compose.yaml]' : '[]'}\n`);
   if (compose) await writeFile(path.join(root,'compose.yaml'), 'services:\n  app:\n    build: .\n    environment:\n      CUSTOM: preserved\n');
   const stage=path.join(root,'resources');
   await mkdir(path.join(stage,'images'),{recursive:true});
   await mkdir(path.join(stage,'cache','npm'),{recursive:true});
   await writeFile(path.join(stage,'cache','npm','.keep'),'');
   await writeFile(path.join(stage,'images','images.tar'),'fixture');
   const bundle=path.join(root,'dev.tar.gz');
   await createArchive(stage,bundle,makeManifest({bundle_kind:'dev',dockpack_version:'0.8.0',project_name:'frontend',target_platform:'linux/amd64',images:['node:22-bookworm-slim','nginx:stable-alpine'],services:[],dependencies:{node:await sha256Files(root,['package-lock.json'])}}));
   for (const method of ['info','warn','error','success']) t.mock.method(logger,method,()=>{});
   t.mock.method(DockerRunner.prototype,'available',()=>true);
   t.mock.method(DockerRunner.prototype,'platform',()=>({os:'linux',id:'linux/amd64'}));
   t.mock.method(DockerRunner.prototype,'buildEnvironment',()=>({BUILDX_BUILDER:'default'}));
   t.mock.method(DockerRunner.prototype,'hasImage',()=>true);
   t.mock.method(DockerRunner.prototype,'imagePlatform',()=> 'linux/amd64');
   t.mock.method(DockerRunner.prototype,'imageId',()=> 'sha256:'+'b'.repeat(64));
   t.mock.method(DockerRunner.prototype,'load',()=>{});
   let inspected=false;
   t.mock.method(DockerRunner.prototype,'run',args=>{
    if(args[0]==='cp') writeFileSync(path.join(args.at(-1),'index.html'),'<h1>fixture</h1>');
    if(args[0]==='buildx') {
     const context=args.at(-1);
     const dockerfile=readFileSync(path.join(context,'Dockerfile'),'utf8');
     assert.match(dockerfile,/\/etc\/nginx\/templates\/default.conf.template/);
     assert.match(dockerfile,/19-dockpack-backend.envsh/);
     assert.match(readFileSync(path.join(context,'default.conf.template'),'utf8'),/\$\{BACKEND_URL\}/);
     inspected=true;
    }
    if(args.some(a=>a.includes('process.stdout.write') && a.includes('.dockpack-static-build.json'))) return JSON.stringify({output:'dist',base:'/'});
    return '';
   });
   t.mock.method(DockerRunner.prototype,'save',(_images,file)=>writeFileSync(file,'fixture'));
   const output=await buildProductionBundle(root,path.join(root,'prod.tar.gz'),bundle);
   assert.equal(inspected,true);
   const unpacked=await extractArchive(output,path.join(root,'unpacked'));
   const manifest=JSON.parse(await readFile(path.join(unpacked,'manifest.json'),'utf8'));
   assert.ok(manifest.required_config.includes('BACKEND_URL'));
   assert.equal(await readFile(path.join(unpacked,'.env.example'),'utf8'),'BACKEND_URL=\n');
   const model=parse(await readFile(path.join(unpacked,'compose','compose.yaml'),'utf8'));
   assert.match(model.services.app.environment.BACKEND_URL,/\$\{BACKEND_URL:\?/);
   if(compose) assert.equal(model.services.app.environment.CUSTOM,'preserved');
  } finally {await rm(root,{recursive:true,force:true});}
 });
}

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
 for (const variant of ['static', 'custom', 'template', 'main']) {
 test(`automatic frontend keeps runtime configuration project-owned ${variant} (${compose ? 'existing Compose' : 'generated Compose'})`, {skip: compose && !detectComposeCommand()}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dockpack-frontend-prod-'));
  try {
   await writeFile(path.join(root, 'package.json'), JSON.stringify({name:'frontend',version:'1.0.0',scripts:{build:'vite build'},devDependencies:{vite:'1.0.0'}}));
   await writeFile(path.join(root, 'package-lock.json'), '{}');
   await writeFile(path.join(root, '.dockpack.yaml'), `project:\n  name: frontend\n  ecosystems: [node]\nruntime:\n  node_version: "22"\napplication:\n  port: 8080\ntarget:\n  dev_platform: linux/amd64\n  production_platform: linux/amd64\ncompose:\n  files: ${compose ? '[compose.yaml]' : '[]'}\n`);
   if (compose) await writeFile(path.join(root,'compose.yaml'), 'services:\n  app:\n    build: .\n    environment:\n      CUSTOM: preserved\n');
   let custom;
   if (variant === 'custom') {
    custom = 'server { listen 80; root /usr/share/nginx/html; location / { try_files $uri $uri/ /index.html; } location /api/v1/agent/ { proxy_pass http://backend:8000; proxy_buffering off; proxy_read_timeout 600s; } }\n';
    await writeFile(path.join(root,'nginx.conf'),custom);
   } else if (variant === 'template' || variant === 'main') {
    custom = 'server { listen 80; location / { try_files $uri /index.html; } location /api/ { proxy_pass ${DOCUMENT_API_URL}; proxy_set_header Host $host; } }\n';
    if(variant==='main') custom = 'events {}\nhttp {\n' + custom + '}\n';
    await writeFile(path.join(root,'proxy.conf'),custom);
    const {appendFile} = await import('node:fs/promises');
    await appendFile(path.join(root,'.dockpack.yaml'), 'frontend:\n  nginx_config: proxy.conf\n  environment:\n    APP_NAME: "${APP_NAME:-documents}"\n  required_env: [DOCUMENT_API_URL]\n');
    await writeFile(path.join(root,'.env.example'),'# Project settings\nDOCUMENT_API_URL=http://api:8000\n');
   }
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
     const template=variant==='main'?'nginx.conf.template':'default.conf.template';
     assert.ok(dockerfile.includes('/etc/nginx/templates/'+template));
     if(variant==='main') assert.match(dockerfile,/NGINX_ENVSUBST_OUTPUT_DIR/);
     assert.doesNotMatch(dockerfile,/19-dockpack-backend.envsh/);
     const content=readFileSync(path.join(context,template),'utf8');
     if(custom) assert.equal(content,custom); else assert.doesNotMatch(content,/BACKEND_URL|proxy_pass/);
     assert.match(content,/\$uri/);
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
   assert.ok(!manifest.required_config.includes('BACKEND_URL'));
   const templated=variant==='template'||variant==='main';
   assert.equal(await readFile(path.join(unpacked,'.env.example'),'utf8'),templated?'# Project settings\nDOCUMENT_API_URL=http://api:8000\nAPP_NAME=\n':'');
   assert.deepEqual(manifest.required_config,templated?['DOCUMENT_API_URL']:[]);
   await assert.rejects(readFile(path.join(unpacked,'compose','.env.example')),{code:'ENOENT'});
   const model=parse(await readFile(path.join(unpacked,'compose','compose.yaml'),'utf8'));
   assert.equal(model.services.app.environment?.BACKEND_URL,undefined);
   if(templated) {
    assert.match(model.services.app.environment.DOCUMENT_API_URL,/\$\{DOCUMENT_API_URL:\?/);
    assert.equal(model.services.app.environment.APP_NAME,'${APP_NAME:-documents}');
   }
   if(compose) assert.equal(model.services.app.environment.CUSTOM,'preserved');
  } finally {await rm(root,{recursive:true,force:true});}
 });
}
}

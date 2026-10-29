import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {validateConfig} from '../dist/config/schema.js';
import {frontendRuntime} from '../dist/prod/frontend-config.js';

test('custom Nginx config must stay inside the project', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'dockpack-nginx-path-'));
 try {
  await mkdir(path.join(root,'project'));
  await writeFile(path.join(root,'outside.conf'),'server {}');
  const config=validateConfig({project:{name:'test'},frontend:{nginx_config:'../outside.conf'}});
  await assert.rejects(frontendRuntime(path.join(root,'project'),config,'/'),/inside the project/);
 } finally {await rm(root,{recursive:true,force:true});}
});

for(const main of [false,true]) {
 test(`real Nginx renders project variables and preserves native variables (${main?'main':'server'})`, {skip:process.env.DOCKPACK_TEST_DOCKER!=='1'}, async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'dockpack-nginx-render-'));
  try {
   await mkdir(path.join(root,'templates'));
   let content='server { listen 80; location / { try_files $uri /index.html; } location /api/ { proxy_pass ${DOCUMENT_API_URL}; proxy_set_header Host $host; } }\n';
   if(main) content='events {}\nhttp {\n'+content+'}\n';
   await writeFile(path.join(root,'nginx.conf'),content);
   const settings=await frontendRuntime(root,validateConfig({project:{name:'test'}}),'/');
   assert.equal(settings.main,main);
   assert.deepEqual(settings.variables,['DOCUMENT_API_URL']);
   assert.deepEqual(settings.required,[]);
   const template=main?'nginx.conf.template':'default.conf.template';
   await writeFile(path.join(root,'templates',template),settings.content);
   const result=spawnSync('docker',['run','--rm','--pull','never','--network','none',
    '--mount',`type=bind,source=${root}/templates,target=/etc/nginx/templates,readonly`,
    '-e','DOCUMENT_API_URL=http://127.0.0.1:8000','-e','NGINX_ENVSUBST_FILTER=^(DOCUMENT_API_URL)$',
    ...(main?['-e','NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx']:[]),
    'nginx:stable-alpine','nginx','-T'],{encoding:'utf8',timeout:30000});
   assert.equal(result.status,0,result.stderr||result.stdout);
   assert.match(result.stdout,/proxy_pass http:\/\/127\.0\.0\.1:8000;/);
   assert.match(result.stdout,/try_files \$uri \/index.html/);
   assert.match(result.stdout,/proxy_set_header Host \$host/);
  } finally {await rm(root,{recursive:true,force:true});}
 });
}

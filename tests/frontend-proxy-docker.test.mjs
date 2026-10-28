import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {nginxTemplate, backendEnvironmentScript} from '../dist/prod/frontend-nginx.js';

// Opt-in: only uses preloaded images, never pulls or installs dependencies.
test('real Nginx proxies API paths, errors, websocket and SSE while serving SPA routes', {skip: process.env.DOCKPACK_TEST_DOCKER !== '1'}, async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'dockpack-proxy-docker-'));
 const id=`dockpack-proxy-${process.pid}-${Date.now()}`;
 const frontend=`${id}-frontend`, backend=`${id}-backend`;
 const docker=(args, allowFailure=false)=>{
  const result=spawnSync('docker',args,{encoding:'utf8',timeout:30000});
  if(!allowFailure) assert.equal(result.status,0,result.stderr || result.stdout);
  return result;
 };
 try {
  for(const dir of ['templates','site']) await mkdir(path.join(root,dir));
  await writeFile(path.join(root,'templates','default.conf.template'),nginxTemplate('/'));
  await writeFile(path.join(root,'site','index.html'),'DOCKPACK_SPA');
  await writeFile(path.join(root,'backend.envsh'),backendEnvironmentScript,{mode:0o755});
  docker(['image','inspect','nginx:stable-alpine']);
  docker(['image','inspect','python:3.13-slim']);
  const mounts=['--mount',`type=bind,source=${root}/templates,target=/etc/nginx/templates,readonly`,'--mount',`type=bind,source=${root}/backend.envsh,target=/docker-entrypoint.d/19-dockpack-backend.envsh,readonly`,'--mount',`type=bind,source=${root}/site,target=/usr/share/nginx/html,readonly`];
  const missing=docker(['run','--rm','--pull','never','--network','none',...mounts,'nginx:stable-alpine','nginx','-t'],true);
  assert.notEqual(missing.status,0);
  assert.match(missing.stderr,/BACKEND_URL/);
  docker(['network','create',id]);
  // Start Nginx first: deferred DNS resolution allows the backend to start later.
  docker(['run','-d','--pull','never','--name',frontend,'--network',id,'-p','127.0.0.1::80','-e','BACKEND_URL=http://backend:8000/',...mounts,'nginx:stable-alpine']);
  const code=`from http.server import BaseHTTPRequestHandler, HTTPServer
import json, time, hashlib, base64
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path == '/api/ws':
   self.send_response(101)
   self.send_header('Upgrade', 'websocket')
   self.send_header('Connection', 'Upgrade')
   self.send_header('Sec-WebSocket-Accept', base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode())
   self.end_headers()
   return
  if self.path == '/api/events':
   self.send_response(200)
   self.send_header('Content-Type', 'text/event-stream')
   self.end_headers()
   self.wfile.write(b'data: first\\n\\n'); self.wfile.flush()
   time.sleep(2)
   self.wfile.write(b'data: second\\n\\n'); self.wfile.flush()
   return
  body=json.dumps({'path':self.path,'host':self.headers.get('Host'),'forwarded':self.headers.get('X-Forwarded-For')}).encode()
  self.send_response(418 if self.path == '/api/fail' else 200)
  self.send_header('Content-Length',str(len(body)))
  self.end_headers()
  self.wfile.write(body)
HTTPServer(('0.0.0.0',8000),Handler).serve_forever()
`;
  docker(['run','-d','--pull','never','--name',backend,'--network',id,'--network-alias','backend','python:3.13-slim','python','-u','-c',code]);
  assert.equal(docker(['inspect','--format','{{.State.Running}}',frontend]).stdout.trim(),'true',docker(['logs',frontend]).stdout);
  const port=docker(['port',frontend,'80/tcp']).stdout.trim().split(':').at(-1);
  const origin=`http://127.0.0.1:${port}`;
  const wait=async(url)=>{
   for(let i=0;i<60;i++) {
    try {const response=await fetch(url); if(response.ok) return response; await response.text();} catch {}
    await new Promise(resolve=>setTimeout(resolve,200));
   }
   assert.fail(docker(['logs',frontend]).stdout);
  };
  assert.equal(await (await wait(origin+'/some/spa/route')).text(),'DOCKPACK_SPA');
  const api=await (await wait(origin+'/api/asset.js?x=one%20two')).json();
  assert.equal(api.path,'/api/asset.js?x=one%20two');
  assert.equal(api.host,'backend:8000');
  assert.ok(api.forwarded);
  assert.equal((await (await fetch(origin+'/api')).json()).path,'/api');
  assert.equal((await fetch(origin+'/api/fail')).status,418);
  assert.equal((await fetch(origin+'/missing.js')).status,404);
  const stream=await fetch(origin+'/api/events');
  const reader=stream.body.getReader();
  const first=new TextDecoder().decode((await reader.read()).value);
  assert.match(first,/data: first/);
  assert.doesNotMatch(first,/data: second/);
  await reader.cancel();
  await new Promise((resolve,reject)=>{
   const request=http.request(origin+'/api/ws',{headers:{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ=='}},response=>{response.resume(); reject(new Error(`expected upgrade, got ${response.statusCode}`));});
   request.on('upgrade',(response,socket)=>{socket.destroy(); try {assert.equal(response.statusCode,101); resolve();} catch(error) {reject(error);}});
   request.on('error',reject);
   request.setTimeout(10000,()=>request.destroy(new Error('websocket timeout')));
   request.end();
  });
 } finally {
  docker(['rm','-f',frontend,backend],true);
  docker(['network','rm',id],true);
  await rm(root,{recursive:true,force:true});
 }
});

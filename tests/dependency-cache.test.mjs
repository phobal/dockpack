import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {collectDependencies} from '../dist/dev/dependency-cache.js';

async function fixture(action) {
 const root=await mkdtemp(path.join(os.tmpdir(),'dockpack-dependency-cache-'));
 try {
  await writeFile(path.join(root,'package.json'),'{"name":"fixture"}');
  await writeFile(path.join(root,'package-lock.json'),'{}');
  let runs=0;
  const docker={imageId:()=> 'sha256:fixture'};
  // DockerRunner.run is synchronous; emulate its artifact write synchronously.
  const {writeFileSync}=await import('node:fs');
  docker.run=args=>{runs++; if(!args.includes('--network')) {const mount=args.find(a=>a.includes('target=/cache'));writeFileSync(path.join(mount.match(/source=(.*),target=\/cache/)[1],'package'),'cached');}};
  const collect=(out='out',platform='linux/arm64',refresh=false)=>collectDependencies(root,path.join(root,out),'node:22',docker,platform,'node',refresh);
  await action({root,collect,docker,runs:()=>runs});
 } finally {await rm(root,{recursive:true,force:true});}
}

test('second collection reuses validated dependency artifacts without running installation containers',()=>fixture(async({root,collect,runs})=>{
 await collect('first'); assert.equal(runs(),2);
 await collect('second'); assert.equal(runs(),2);
 assert.equal(await readFile(path.join(root,'second','npm','package'),'utf8'),'cached');
}));
test('manifest changes, platform changes and refresh invalidate reuse',()=>fixture(async({root,collect,runs})=>{
 await collect('one');
 await writeFile(path.join(root,'package.json'),'{"name":"updated"}');
 await collect('two'); assert.equal(runs(),4);
 await collect('three','linux/amd64'); assert.equal(runs(),6);
 await collect('four','linux/amd64',true); assert.equal(runs(),8);
}));
test('corrupt cached artifacts trigger fresh collection',()=>fixture(async({root,collect,runs})=>{
 await collect('one');
 const {readdir}=await import('node:fs/promises');
 const base=path.join(root,'.dockpack','cache','dependencies');
 const [key]=(await readdir(base)).filter(name=>!name.startsWith('.'));
 await writeFile(path.join(base,key,'payload','npm','package'),'broken');
 await collect('two'); assert.equal(runs(),4);
 assert.equal(await readFile(path.join(root,'two','npm','package'),'utf8'),'cached');
}));
test('runtime image identity changes invalidate reuse',()=>fixture(async({collect,docker,runs})=>{
 await collect('one'); docker.imageId=()=> 'sha256:updated';
 await collect('two'); assert.equal(runs(),4);
}));

test('failed refresh keeps previously validated cache usable',()=>fixture(async({collect,docker,runs})=>{
 await collect('one');
 const run=docker.run;
 docker.run=()=>{throw new Error('registry unavailable');};
 await assert.rejects(collect('failed','linux/arm64',true),/npm/);
 docker.run=run;
 await collect('two'); assert.equal(runs(),2);
}));
test('npm registry configuration changes invalidate cache',()=>fixture(async({root,collect,runs})=>{
 await collect('one'); await writeFile(path.join(root,'.npmrc'),'registry=https://example.invalid\n');
 await collect('two'); assert.equal(runs(),4);
}));

test('uv export, wheel downloads and offline validation are reused together', async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dockpack-uv-cache-'));
 try {
  await writeFile(path.join(root,'pyproject.toml'),'[project]\nname="fixture"\nversion="1.0"\ndependencies=["idna==3.10"]\n');
  await writeFile(path.join(root,'uv.lock'),'version=1\n[[package]]\nname="idna"\nversion="3.10"\nsource={registry="https://pypi.org/simple"}\n');
  const {writeFileSync}=await import('node:fs');
  let runs=0;
  const docker={imageId:()=> 'sha256:python',run(args){
   runs++;
   if(args.some(a=>a.includes("'uv',"))) {
    const mount=args.find(a=>a.includes('target=/cache'));
    writeFileSync(path.join(mount.match(/source=(.*),target=\/cache/)[1],'python-requirements.txt'),'idna==3.10\n');
   }
  }};
  const first=await collectDependencies(root,path.join(root,'first'),'python:3.11',docker,'linux/arm64','python');
  assert.equal(runs,3);
  const second=await collectDependencies(root,path.join(root,'second'),'python:3.11',docker,'linux/arm64','python');
  assert.equal(runs,3); assert.deepEqual(second,first);
  assert.equal(await readFile(path.join(root,'second','python-requirements.txt'),'utf8'),'idna==3.10\n');
  await writeFile(path.join(root,'uv.toml'),'index-strategy="first-index"\n');
  await collectDependencies(root,path.join(root,'third'),'python:3.11',docker,'linux/arm64','python');
  assert.equal(runs,6);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('pip requirements include files participate in cache invalidation',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dockpack-pip-cache-'));
 try {
  await writeFile(path.join(root,'requirements.txt'),'-r nested.txt\n');
  await writeFile(path.join(root,'nested.txt'),'idna==3.10\n');
  let runs=0;
  const docker={imageId:()=> 'sha256:python',run(){runs++;}};
  await collectDependencies(root,path.join(root,'first'),'python:3.11',docker,'linux/arm64','python');
  await collectDependencies(root,path.join(root,'second'),'python:3.11',docker,'linux/arm64','python');
  assert.equal(runs,1);
  await writeFile(path.join(root,'nested.txt'),'idna==3.11\n');
  await collectDependencies(root,path.join(root,'third'),'python:3.11',docker,'linux/arm64','python');
  assert.equal(runs,2);
 } finally {await rm(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runCompose} from '../dist/compose/command.js';

test('Compose errors preserve npm JSON stdout alongside stderr diagnostics', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dockpack-compose-error-'));
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(root, 'docker'), `#!${process.execPath}\nif (process.argv.includes('version')) { console.log('Docker Compose version v2.30.0'); } else { console.log(JSON.stringify({error:{code:'ELIFECYCLE',detail:'prepare failed'}})); console.error('container created; install failed'); process.exit(1); }\n`, {mode: 0o755});
    process.env.PATH = root + path.delimiter + originalPath;
    assert.throws(() => runCompose(['run', '--rm', 'app'], root), error => {
      assert.match(error.message, /ELIFECYCLE/);
      assert.match(error.message, /container created; install failed/);
      return true;
    });
  } finally {process.env.PATH = originalPath; await rm(root, {recursive: true, force: true});}
});

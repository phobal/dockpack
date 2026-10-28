import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageCollector } from '../dist/docker/collect.js';

function fixture(policy, initial = {}) {
  const images = new Map(Object.entries(initial));
  const pulls = [];
  const docker = {
    hasImage: image => images.has(image),
    imagePlatform: image => images.get(image),
    pull(image, platform) { pulls.push([image, platform]); images.set(image, platform); },
  };
  return { ensure: createImageCollector(docker, policy), images, pulls };
}
test('missing reuses matching images and pulls absent or mismatched images', () => {
  const { ensure, pulls } = fixture('missing', { cached: 'linux/amd64', wrong: 'linux/arm64' });
  ensure('cached', 'linux/amd64');
  ensure('absent', 'linux/amd64');
  ensure('wrong', 'linux/amd64');
  assert.deepEqual(pulls, [['absent', 'linux/amd64'], ['wrong', 'linux/amd64']]);
});
test('always refreshes cached images once per image and platform', () => {
  const { ensure, pulls } = fixture('always', { image: 'linux/amd64' });
  ensure('image', 'linux/amd64');
  ensure('image', 'linux/amd64');
  ensure('image', 'linux/arm64');
  assert.deepEqual(pulls, [['image', 'linux/amd64'], ['image', 'linux/arm64']]);
});
test('never rejects missing and mismatched images without pulling', () => {
  const { ensure, pulls } = fixture('never', { image: 'linux/arm64' });
  assert.throws(() => ensure('absent', 'linux/amd64'), /absent.*linux\/amd64/);
  assert.throws(() => ensure('image', 'linux/amd64'), /linux\/arm64.*linux\/amd64/);
  ensure('image', 'linux/arm64');
  assert.deepEqual(pulls, []);
});
test('a tag replaced with another platform must be restored even after prior collection', () => {
  const { ensure, images, pulls } = fixture('missing');
  ensure('image', 'linux/amd64');
  images.set('image', 'linux/arm64');
  ensure('image', 'linux/amd64');
  assert.equal(pulls.length, 2);
});
test('default policy is missing and invalid policies fail early', () => {
  const { ensure, pulls } = fixture(undefined, { image: 'linux/amd64' });
  ensure('image', 'linux/amd64');
  assert.equal(pulls.length, 0);
  assert.throws(() => fixture('invalid'), /pull policy/i);
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDevelopmentBundle } from '../dist/dev/pack.js';
import { DockerRunner } from '../dist/docker/runner.js';
import { detectComposeCommand } from '../dist/compose/inspect.js';
import { logger } from '../dist/logger.js';

for (const policy of ['missing', 'always', 'never']) {
  test(`pack dev applies ${policy} to runtime, Compose and Dockerfile images`, { skip: !detectComposeCommand() }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dockpack-pull-'));
    try {
      await writeFile(path.join(root, '.dockpack.yaml'), 'project:\n  name: pull-test\n  ecosystems: [python]\nruntime:\n  python_version: "3.11"\ntarget:\n  dev_platform: linux/amd64\ncompose:\n  files: [compose.yaml]\n');
      await writeFile(path.join(root, 'requirements.txt'), '');
      await writeFile(path.join(root, 'Dockerfile'), 'FROM python:3.11-slim\nFROM example/base:1\n');
      await writeFile(path.join(root, 'compose.yaml'), 'services:\n  cache:\n    image: example/cache:1\n');
      for (const method of ['info', 'warn', 'error', 'success']) t.mock.method(logger, method, () => {});
      t.mock.method(DockerRunner.prototype, 'available', () => true);
      t.mock.method(DockerRunner.prototype, 'hasImage', () => true);
      t.mock.method(DockerRunner.prototype, 'imagePlatform', () => 'linux/amd64');
      t.mock.method(DockerRunner.prototype, 'run', () => '');
      const pulls = t.mock.method(DockerRunner.prototype, 'pull', () => {});
      const stop = new Error('reached image export');
      t.mock.method(DockerRunner.prototype, 'save', () => { throw stop; });
      await assert.rejects(createDevelopmentBundle(root, undefined, policy), error => error === stop);
      assert.deepEqual(pulls.mock.calls.map(c => c.arguments.slice(0, 2)), policy === 'always' ? [
        ['python:3.11-slim', 'linux/amd64'], ['example/cache:1', 'linux/amd64'], ['example/base:1', 'linux/amd64'],
      ] : []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerRunner } from '../dist/docker/runner.js';
import { createImageCollector } from '../dist/docker/collect.js';

test('inspect selects the requested variant instead of the daemon default', () => {
  const docker = new DockerRunner();
  docker.run = args => {
    assert.deepEqual(args, ['image', 'inspect', '--platform', 'linux/arm64', '--format', '{{.Os}}/{{.Architecture}}', 'multi:tag']);
    return 'linux/arm64';
  };
  assert.equal(docker.imagePlatform('multi:tag', 'linux/arm64'), 'linux/arm64');
});

test('export selects only the requested platform', () => {
  const docker = new DockerRunner();
  docker.run = args => assert.deepEqual(args, ['image', 'save', '--platform', 'linux/arm64', '--output', 'images.tar', 'multi:tag']);
  docker.save(['multi:tag'], 'images.tar', false, 'linux/arm64');
});

test('collector reuses an available variant even when default architecture differs', () => {
  createImageCollector({
    hasImage: () => true,
    imagePlatform: (_, platform) => platform === 'linux/arm64' ? platform : 'linux/amd64',
    pull: () => assert.fail('must not pull an already cached variant'),
  }, 'never')('multi:tag', 'linux/arm64');
});

test('collector pulls when the tag exists but requested variant is missing', () => {
  const pulls = [];
  createImageCollector({
    hasImage: () => true,
    imagePlatform: () => { throw new Error('requested platform unavailable'); },
    pull: (...args) => pulls.push(args),
  })('multi:tag', 'linux/arm64');
  assert.deepEqual(pulls, [['multi:tag', 'linux/arm64', true]]);
});

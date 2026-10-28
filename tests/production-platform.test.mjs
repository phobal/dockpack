import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../dist/config/schema.js';
import { createArchive, inspectArchive } from '../dist/bundles/archive.js';
import { makeManifest } from '../dist/bundles/manifest.js';
import { sha256Files } from '../dist/dev/dependencies.js';
import { buildProductionBundle } from '../dist/prod/build.js';
import { DockerRunner } from '../dist/docker/runner.js';
import { detectComposeCommand } from '../dist/compose/inspect.js';
import { logger } from '../dist/logger.js';

test('production platform accepts amd64 and arm64, defaults to amd64, rejects unsupported values', () => {
  assert.equal(validateConfig({project: {name: 'test'}}).target.production_platform, 'linux/amd64');
  for (const platform of ['linux/amd64', 'linux/arm64']) {
    assert.equal(validateConfig({project: {name: 'test'}, target: {production_platform: platform}}).target.production_platform, platform);
  }
  for (const platform of ['linux/riscv64', 'darwin/arm64', 'auto']) {
    assert.throws(() => validateConfig({project: {name: 'test'}, target: {production_platform: platform}}), /production_platform/);
  }
});

for (const platform of ['linux/amd64', 'linux/arm64']) {
 for (const mode of ['generated', 'compose']) {
  test(`${mode} production build propagates ${platform} through build and archive`, {skip: mode === 'compose' && !detectComposeCommand()}, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dockpack-prod-platform-'));
    try {
      await writeFile(path.join(root, 'requirements.txt'), '');
      await writeFile(path.join(root, 'main.py'), 'print("hello")\n');
      await writeFile(path.join(root, '.dockpack.yaml'), `project:\n  name: platform-test\n  ecosystems: [python]\nruntime:\n  python_version: "3.11"\napplication:\n  command: [python, main.py]\ntarget:\n  dev_platform: ${platform}\n  production_platform: ${platform}\n`);
      if (mode === 'compose') {
        const config = path.join(root, '.dockpack.yaml');
        const { readFile } = await import('node:fs/promises');
        await writeFile(config, (await readFile(config, 'utf8')) + 'compose:\n  files: [compose.yaml]\n');
        await writeFile(path.join(root, 'compose.yaml'), 'services:\n  app:\n    image: example/app:1\n');
      }
      const stage = path.join(root, 'resources');
      await mkdir(path.join(stage, 'cache', 'python'), {recursive: true});
      await writeFile(path.join(stage, 'cache', 'python', '.keep'), '');
      await mkdir(path.join(stage, 'images'), {recursive: true});
      await writeFile(path.join(stage, 'images', 'images.tar'), 'fixture');
      const bundle = path.join(root, 'dev.tar.gz');
      await createArchive(stage, bundle, makeManifest({bundle_kind: 'dev', dockpack_version: '0.8.0', project_name: 'platform-test', target_platform: platform, images: ['python:3.11-slim'], services: [], dependencies: {python: await sha256Files(root, ['requirements.txt'])}}));
      for (const method of ['info', 'warn', 'error', 'success']) t.mock.method(logger, method, () => {});
      t.mock.method(DockerRunner.prototype, 'available', () => true);
      // Opposite host architecture verifies the configured target is authoritative.
      t.mock.method(DockerRunner.prototype, 'platform', () => ({os: 'linux', id: platform === 'linux/arm64' ? 'linux/amd64' : 'linux/arm64'}));
      t.mock.method(DockerRunner.prototype, 'buildEnvironment', () => ({BUILDX_BUILDER: 'default'}));
      t.mock.method(DockerRunner.prototype, 'load', () => {});
      t.mock.method(DockerRunner.prototype, 'hasImage', () => true);
      t.mock.method(DockerRunner.prototype, 'imagePlatform', () => platform);
      t.mock.method(DockerRunner.prototype, 'imageId', () => 'sha256:' + 'a'.repeat(64));
      const commands = [];
      t.mock.method(DockerRunner.prototype, 'run', args => {commands.push(args); return '';});
      t.mock.method(DockerRunner.prototype, 'save', (_images, output) => writeFileSync(output, 'fixture'));
      const output = await buildProductionBundle(root, undefined, bundle);
      assert.equal(output, path.join(root, '.dockpack', `offline-prod-${platform.replace('/', '-')}.tar.gz`));
      const manifest = await inspectArchive(output);
      assert.equal(manifest.target_platform, platform);
      assert.equal(manifest.bundle_kind, 'prod');
      const build = commands.find(args => args[0] === 'buildx');
      if (mode === 'generated') {
        assert.equal(build[build.indexOf('--platform') + 1], platform);
        assert.ok(build.includes('--pull=false'));
      } else {
        assert.equal(build, undefined);
        assert.deepEqual(manifest.services, ['app']);
      }
    } finally {await rm(root, {recursive: true, force: true});}
  });
}
}

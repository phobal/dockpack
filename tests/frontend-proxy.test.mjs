import test from 'node:test';
import assert from 'node:assert/strict';
import { nginxTemplate, backendEnvironmentScript } from '../dist/prod/frontend-nginx.js';
import { spawnSync } from 'node:child_process';

test('API locations preserve paths, outrank static assets and support streaming and websocket', () => {
 const text = nginxTemplate('/app/');
 assert.match(text, /location = \/api/);
 assert.match(text, /location \^~ \/api\//);
 assert.match(text, /proxy_pass \$dockpack_backend\$request_uri;/);
 assert.match(text, /proxy_buffering off/);
 assert.match(text, /proxy_set_header Upgrade \$http_upgrade/);
 assert.match(text, /proxy_set_header Connection \$dockpack_connection/);
 assert.match(text, /try_files \$uri \$uri\/ \/app\/index.html/);
});

for (const value of ['http://backend:8000', 'https://api.example.com/', 'http://[::1]:8000/']) {
 test(`startup accepts and normalizes backend origin ${value}`, () => {
  const result = spawnSync('sh', ['-c', backendEnvironmentScript + '\nprintf "%s" "$BACKEND_URL"'], {encoding:'utf8', env:{...process.env, BACKEND_URL:value}});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, value.replace(/\/$/, ''));
 });
}
for (const value of ['', 'backend:8000', 'http://host/api', 'http://host?x=1', 'http://host;bad', 'http://user:pass@host', 'http://host\ninvalid']) {
 test(`startup rejects invalid backend origin ${JSON.stringify(value)}`, () => {
  const result = spawnSync('sh', ['-c', backendEnvironmentScript], {encoding:'utf8', env:{...process.env, BACKEND_URL:value}});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BACKEND_URL/);
 });
}

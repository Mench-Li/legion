import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSecurityConfig } from '../src/security.mjs';
import { authorizedUpgrade } from '../src/ws.mjs';

test('whiteboard loopback may run without token', () => {
  assert.equal(validateSecurityConfig({ host: '127.0.0.1', token: '' }), true);
});

test('whiteboard non-loopback requires token', () => {
  assert.throws(() => validateSecurityConfig({ host: '0.0.0.0', token: '' }), /WHITEBOARD_TOKEN/);
  assert.equal(validateSecurityConfig({ host: '0.0.0.0', token: 'secret' }), true);
});

test('websocket upgrade accepts bearer/query token and rejects wrong token', () => {
  assert.equal(authorizedUpgrade({ url: '/ws', headers: { authorization: 'Bearer secret' } }, 'secret'), true);
  assert.equal(authorizedUpgrade({ url: '/ws?token=secret', headers: {} }, 'secret'), true);
  assert.equal(authorizedUpgrade({ url: '/ws?token=nope', headers: {} }, 'secret'), false);
});

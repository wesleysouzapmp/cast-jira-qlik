import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, loadMasterKey } from '../src/auth/crypto.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { randomToken, sha256 } from '../src/auth/tokens.js';

const key = randomBytes(32);

test('encrypt/decrypt: ida e volta', () => {
  const blob = encrypt('segredo ç ã', key);
  assert.match(blob, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(decrypt(blob, key), 'segredo ç ã');
});

test('encrypt: mesmo texto gera blocos diferentes', () => {
  assert.notEqual(encrypt('abc', key), encrypt('abc', key));
});

test('decrypt: bloco adulterado lança', () => {
  const parts = encrypt('abc', key).split(':');
  const d = parts[3];
  parts[3] = (d[0] === 'A' ? 'B' : 'A') + d.slice(1);
  assert.throws(() => decrypt(parts.join(':'), key), /decrypt/);
});

test('decrypt: chave errada lança', () => {
  assert.throws(() => decrypt(encrypt('abc', key), randomBytes(32)), /decrypt/);
});

test('loadMasterKey: aceita 32 bytes, recusa ausente e 16 bytes', () => {
  const k = loadMasterKey({ APP_SECRET_KEY: key.toString('base64') });
  assert.equal(k.length, 32);
  assert.throws(() => loadMasterKey({}), /APP_SECRET_KEY/);
  assert.throws(() => loadMasterKey({ APP_SECRET_KEY: randomBytes(16).toString('base64') }), /32/);
});

test('senhas: hash scrypt$, aceita certa e recusa errada', async () => {
  const h = await hashPassword('correta');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(h.split('$').length, 3);
  assert.equal(await verifyPassword('correta', h), true);
  assert.equal(await verifyPassword('errada', h), false);
  assert.equal(await verifyPassword('x', 'lixo'), false);
});

test('tokens: randomToken tem 43 chars e é único; sha256 é hex', () => {
  const a = randomToken();
  assert.equal(a.length, 43);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, randomToken());
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('decrypt: tag truncado lança', () => {
  const p = encrypt('abc', key).split(':');
  p[2] = Buffer.from(p[2], 'base64').subarray(0, 4).toString('base64');
  assert.throws(() => decrypt(p.join(':'), key), /decrypt/);
});

test('decrypt: tag adulterado lança', () => {
  const p = encrypt('abc', key).split(':');
  const t = Buffer.from(p[2], 'base64');
  t[0] ^= 1;
  p[2] = t.toString('base64');
  assert.throws(() => decrypt(p.join(':'), key), /decrypt/);
});

test('decrypt: blob malformado lança', () => {
  assert.throws(() => decrypt('', key), /decrypt/);
  assert.throws(() => decrypt('v2:a:b:c', key), /decrypt/);
});

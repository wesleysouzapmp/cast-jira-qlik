import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createOAuthRepo, ACCESS_TTL_MS, REFRESH_TTL_MS, CODE_TTL_MS } from '../src/db/oauth.js';
import { sha256 } from '../src/auth/tokens.js';

function setup() {
  const db = openDb();
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const users = createUserRepo(db, randomBytes(32), clock.now);
  const ana = users.create({ email: 'ana@x.com', name: 'Ana', role: 'user', passwordHash: 'h' });
  const bia = users.create({ email: 'bia@x.com', name: 'Bia', role: 'user', passwordHash: 'h' });
  const oauth = createOAuthRepo(db, clock.now);
  const info = {
    client_id: 'c1', client_id_issued_at: 123, redirect_uris: ['https://claude.ai/cb'],
    client_name: 'Claude', token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'jira',
  };
  oauth.saveClient(info);
  oauth.saveClient({ ...info, client_id: 'c2', client_name: 'Outro' });
  return { db, clock, oauth, ana, bia, info };
}
const codeArgs = (s, extra = {}) => ({ code: 'cod1', clientId: 'c1', userId: s.ana.id, challenge: 'ch', redirectUri: 'https://claude.ai/cb', scopes: ['jira'], ...extra });

test('saveClient/getClient: round-trip do metadata completo', () => {
  const s = setup();
  assert.deepEqual(s.oauth.getClient('c1'), s.info);
  assert.equal(s.oauth.getClient('nao'), null);
  assert.equal(Object.getPrototypeOf(s.oauth.getClient('c1')), Object.prototype);
});

test('client_secret: só o hash é gravado; verifyClientSecret confere', () => {
  const s = setup();
  s.oauth.saveClient({ ...s.info, client_id: 'c3', client_secret: 'segredo' });
  assert.equal(s.oauth.getClient('c3').client_secret, undefined);
  const row = s.db.prepare("SELECT client_secret_hash, metadata FROM oauth_clients WHERE client_id='c3'").get();
  assert.equal(row.client_secret_hash, sha256('segredo'));
  assert.ok(!row.metadata.includes('segredo'));
  assert.equal(s.oauth.verifyClientSecret('c3', 'segredo'), true);
  assert.equal(s.oauth.verifyClientSecret('c3', 'errado'), false);
  assert.equal(s.oauth.verifyClientSecret('c1', 'x'), false);
});

test('código: uso único, devolve os dados gravados', () => {
  const s = setup();
  s.oauth.saveCode(codeArgs(s, { resource: 'https://h/mcp' }));
  const c = s.oauth.takeCode('cod1');
  assert.deepEqual(c, { clientId: 'c1', userId: s.ana.id, challenge: 'ch', redirectUri: 'https://claude.ai/cb', scopes: ['jira'], resource: 'https://h/mcp' });
  assert.equal(s.oauth.takeCode('cod1'), null);
});

test('código vencido dá null', () => {
  const s = setup();
  s.oauth.saveCode(codeArgs(s));
  s.clock.advance(CODE_TTL_MS + 1);
  assert.equal(s.oauth.takeCode('cod1'), null);
  assert.equal(s.oauth.takeCode('inexistente'), null);
});

test('issueTokens + verify; só hashes no banco', () => {
  const s = setup();
  const t = s.oauth.issueTokens({ clientId: 'c1', userId: s.ana.id, scopes: ['jira'] });
  assert.equal(t.expires_in, 3600);
  assert.deepEqual(s.oauth.verify(t.access_token), { userId: s.ana.id, clientId: 'c1', scopes: ['jira'], expiresAt: 1_000_000 + ACCESS_TTL_MS });
  const rows = s.db.prepare('SELECT token_hash, kind FROM oauth_tokens').all();
  assert.equal(rows.length, 2);
  const hashes = rows.map((r) => r.token_hash);
  assert.ok(hashes.includes(sha256(t.access_token)) && hashes.includes(sha256(t.refresh_token)));
  assert.ok(!hashes.includes(t.access_token) && !hashes.includes(t.refresh_token));
  s.oauth.saveCode(codeArgs(s));
  const dump = JSON.stringify(s.db.prepare('SELECT * FROM oauth_codes').all());
  assert.ok(!dump.includes('cod1'));
  assert.equal(s.oauth.verify('lixo'), null);
  assert.equal(s.oauth.verify(t.refresh_token), null, 'refresh não vale como access');
});

test('verify: vencido e revogado dão null', () => {
  const s = setup();
  const a = s.oauth.issueTokens({ clientId: 'c1', userId: s.ana.id, scopes: [] });
  const b = s.oauth.issueTokens({ clientId: 'c1', userId: s.ana.id, scopes: [] });
  s.oauth.revoke(b.access_token);
  assert.equal(s.oauth.verify(b.access_token), null);
  assert.ok(s.oauth.verify(a.access_token));
  s.clock.advance(ACCESS_TTL_MS + 1);
  assert.equal(s.oauth.verify(a.access_token), null);
});

test('refresh gira: antigo revogado, novo vale; cliente errado/vencido falha', () => {
  const s = setup();
  const t = s.oauth.issueTokens({ clientId: 'c1', userId: s.ana.id, scopes: ['jira'] });
  assert.equal(s.oauth.refresh(t.refresh_token, 'c2'), null);
  const n = s.oauth.refresh(t.refresh_token, 'c1');
  assert.equal(n.expires_in, 3600);
  assert.notEqual(n.refresh_token, t.refresh_token);
  assert.equal(s.oauth.refresh(t.refresh_token, 'c1'), null);
  assert.ok(s.oauth.verify(n.access_token));
  assert.deepEqual(s.oauth.verify(n.access_token).scopes, ['jira']);
  s.clock.advance(REFRESH_TTL_MS + 1);
  assert.equal(s.oauth.refresh(n.refresh_token, 'c1'), null);
});

test('revokeFor(user) não afeta outro usuário; com clientId só aquele cliente', () => {
  const s = setup();
  const a1 = s.oauth.issueTokens({ clientId: 'c1', userId: s.ana.id, scopes: [] });
  const a2 = s.oauth.issueTokens({ clientId: 'c2', userId: s.ana.id, scopes: [] });
  const b1 = s.oauth.issueTokens({ clientId: 'c1', userId: s.bia.id, scopes: [] });
  s.oauth.revokeFor(s.ana.id, 'c1');
  assert.equal(s.oauth.verify(a1.access_token), null);
  assert.equal(s.oauth.refresh(a1.refresh_token, 'c1'), null);
  assert.ok(s.oauth.verify(a2.access_token));
  assert.ok(s.oauth.verify(b1.access_token));
  s.oauth.revokeFor(s.ana.id);
  assert.equal(s.oauth.verify(a2.access_token), null);
  assert.ok(s.oauth.verify(b1.access_token));
});

test('revoke(refresh) invalida o refresh', () => {
  const s = setup();
  const t = s.oauth.issueTokens({ clientId: 'c1', userId: s.ana.id, scopes: [] });
  s.oauth.revoke(t.refresh_token);
  assert.equal(s.oauth.refresh(t.refresh_token, 'c1'), null);
});

test('connectorsFor: clientes distintos com tokens ativos, sem tokens', () => {
  const s = setup();
  s.oauth.issueTokens({ clientId: 'c1', userId: s.ana.id, scopes: [] });
  s.clock.advance(1000);
  s.oauth.issueTokens({ clientId: 'c1', userId: s.ana.id, scopes: [] });
  const c2 = s.oauth.issueTokens({ clientId: 'c2', userId: s.ana.id, scopes: [] });
  s.oauth.issueTokens({ clientId: 'c1', userId: s.bia.id, scopes: [] });
  let list = s.oauth.connectorsFor(s.ana.id);
  assert.equal(list.length, 2);
  const c1 = list.find((c) => c.clientId === 'c1');
  assert.deepEqual(c1, { clientId: 'c1', name: 'Claude', createdAt: 1_000_000, lastUsedAt: 1_001_000 });
  assert.ok(!JSON.stringify(list).includes(c2.access_token));
  s.oauth.revokeFor(s.ana.id, 'c2');
  list = s.oauth.connectorsFor(s.ana.id);
  assert.deepEqual(list.map((c) => c.clientId), ['c1']);
  s.oauth.revokeFor(s.ana.id);
  assert.deepEqual(s.oauth.connectorsFor(s.ana.id), []);
});

test('peekCode: lê sem consumir; vencido ou inexistente dá null', () => {
  const s = setup();
  s.oauth.saveCode(codeArgs(s));
  const expected = { clientId: 'c1', userId: s.ana.id, challenge: 'ch', redirectUri: 'https://claude.ai/cb', scopes: ['jira'], resource: undefined };
  assert.deepEqual(s.oauth.peekCode('cod1'), expected);
  assert.deepEqual(s.oauth.peekCode('cod1'), expected);
  assert.deepEqual(s.oauth.takeCode('cod1'), expected);
  assert.equal(s.oauth.peekCode('cod1'), null);
  assert.equal(s.oauth.peekCode(''), null);
  s.oauth.saveCode(codeArgs(s, { code: 'cod2' }));
  s.clock.advance(CODE_TTL_MS + 1);
  assert.equal(s.oauth.peekCode('cod2'), null);
});

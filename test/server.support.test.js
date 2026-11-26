// Rotas das Tarefas de apoio com modelos: CRUD de modelos (permissão e visibilidade), prévia e
// criação por épico, último modelo usado e a chave "Pode criar modelos" na administração.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers/app.js';
import { createCatalogRepo } from '../src/db/catalog.js';

const CATALOG = [
  { cat: 'CAT-105', size: 'P', ust: 1, task: 'Realizar diagnóstico' },
  { cat: 'CAT-105', size: 'M', ust: 2, task: 'Realizar diagnóstico' },
  { cat: 'CAT-166', size: 'P', ust: 8, task: 'Manter script' },
  { cat: 'CAT-200', size: 'G', ust: 5, task: 'Revisar painel' },
];

function fakeSupport() {
  const calls = [];
  const svc = {
    async listItems() { return { items: [], truncated: false }; },
    async preview(keys, opts) { calls.push(['preview', keys, opts]); return { epics: [], rejected: [] }; },
    async create(keys, tasks) {
      calls.push(['create', keys, tasks]);
      return { results: Object.entries(tasks).flatMap(([epic, list]) => list.map((t, n) => ({ epic, cat: t.cat, size: t.size, summary: t.summary, status: n ? 'error' : 'created', ...(n ? { error: 'x' } : { key: `QSENSE-${n + 1}` }) }))) };
    },
  };
  return { svc, calls };
}

async function setup() {
  const s = fakeSupport();
  const t = await makeTestApp({ services: { supportService: s.svc } });
  createCatalogRepo(t.db).replaceAll(CATALOG, null);
  const bia = t.login({ email: 'bia@x.com', name: 'Bia' });
  const caio = t.login({ email: 'caio@x.com', name: 'Caio' });
  t.users.setCanCreateTemplates(bia.user.id, true);
  return { ...t, calls: s.calls, bia, caio };
}

const body = (o = {}) => ({ name: 'Meu modelo', public: false, items: [{ cat: 'CAT-200', size: 'G', summary: 'Revisão {EPICO}', description: '' }], ...o });
const audits = (db) => db.prepare('SELECT action, detail FROM audit ORDER BY id').all().map((r) => [r.action, JSON.parse(r.detail)]);

test('GET templates: Padrão visível para todos, canEdit e último usado', async () => {
  const t = await setup();
  const r = await (await t.caio.json('GET', '/api/support/templates')).json();
  assert.equal(r.canEdit, false);
  assert.equal(r.lastUsedId, 'padrao');
  assert.deepEqual(r.templates.map((x) => [x.id, x.name, x.public, x.system, x.canEdit]), [['padrao', 'Padrão', true, true, false]]);
  assert.equal(r.templates[0].items.length, 2);
  const admin = await (await t.json('GET', '/api/support/templates')).json();
  assert.equal(admin.canEdit, true);
  assert.equal(admin.templates[0].canEdit, true);
});

test('criar modelo: só admin ou usuário habilitado; dono é quem cria', async () => {
  const t = await setup();
  assert.equal((await t.caio.json('POST', '/api/support/templates', body())).status, 403);
  const res = await t.bia.json('POST', '/api/support/templates', body());
  assert.equal(res.status, 200);
  const { template } = await res.json();
  assert.equal(template.ownerName, 'Bia');
  assert.equal(template.canEdit, true);
  assert.equal((await t.json('POST', '/api/support/templates', body({ name: 'Do admin', public: true }))).status, 200);
  assert.deepEqual(audits(t.db).map(([a, d]) => [a, d.name, d.items]), [['support.template.create', 'Meu modelo', 1], ['support.template.create', 'Do admin', 1]]);
});

test('visibilidade: privado só para o dono e o admin; público para todos', async () => {
  const t = await setup();
  const { template: priv } = await (await t.bia.json('POST', '/api/support/templates', body({ name: 'Privado' }))).json();
  const { template: pub } = await (await t.bia.json('POST', '/api/support/templates', body({ name: 'Público', public: true }))).json();
  const names = async (who) => (await (await who.json('GET', '/api/support/templates')).json()).templates.map((x) => x.name);
  assert.deepEqual(await names(t.caio), ['Padrão', 'Público']);
  assert.deepEqual(await names(t.bia), ['Padrão', 'Privado', 'Público']);
  assert.deepEqual(await names(t), ['Padrão', 'Privado', 'Público']);
  // Caio não vê o privado (404) e não edita o público de outra pessoa (403).
  t.users.setCanCreateTemplates(t.caio.user.id, true);
  assert.equal((await t.caio.json('PUT', `/api/support/templates/${priv.id}`, body())).status, 404);
  assert.equal((await t.caio.json('PUT', `/api/support/templates/${pub.id}`, body())).status, 403);
  assert.equal((await t.caio.json('DELETE', `/api/support/templates/${pub.id}`)).status, 403);
  // Prévia com modelo privado de outra pessoa: 404.
  assert.equal((await t.caio.json('POST', '/api/support/preview', { keys: ['BI-1'], templateId: priv.id })).status, 404);
});

test('editar/excluir: dono (habilitado) ou admin; modelo do sistema só o admin', async () => {
  const t = await setup();
  const { template } = await (await t.bia.json('POST', '/api/support/templates', body())).json();
  const put = await t.bia.json('PUT', `/api/support/templates/${template.id}`, body({ name: 'Renomeado', public: true }));
  assert.equal(put.status, 200);
  assert.equal((await put.json()).template.name, 'Renomeado');
  assert.equal((await t.json('PUT', `/api/support/templates/${template.id}`, body({ name: 'Pelo admin' }))).status, 200);
  assert.equal((await t.bia.json('PUT', '/api/support/templates/padrao', body())).status, 403);
  // Sem a chave, o dono não edita mais.
  t.users.setCanCreateTemplates(t.bia.user.id, false);
  assert.equal((await t.bia.json('DELETE', `/api/support/templates/${template.id}`)).status, 403);
  t.users.setCanCreateTemplates(t.bia.user.id, true);
  assert.equal((await t.bia.json('DELETE', `/api/support/templates/${template.id}`)).status, 200);
  assert.equal((await t.bia.json('DELETE', `/api/support/templates/${template.id}`)).status, 404);
  assert.equal((await t.json('PUT', '/api/support/templates/padrao', body({ name: 'Padrão', public: true }))).status, 200);
  assert.deepEqual(audits(t.db).map(([a]) => a), ['support.template.create', 'support.template.update', 'support.template.update', 'support.template.delete', 'support.template.update']);
});

test('validação do modelo no servidor (400 com mensagem)', async () => {
  const t = await setup();
  const cases = [
    [body({ name: '' }), /nome/i],
    [body({ name: 'x'.repeat(81) }), /80/],
    [body({ items: [] }), /20/],
    [body({ items: Array.from({ length: 21 }, () => body().items[0]) }), /20/],
    [body({ items: [{ cat: 'CAT-999', size: 'P', summary: 'X' }] }), /CAT-999/],
    [body({ items: [{ cat: 'CAT-166', size: 'G', summary: 'X' }] }), /CAT-166 não tem tamanho G/],
    [body({ items: [{ cat: 'CAT-166', size: 'P', summary: 'x'.repeat(256) }] }), /255/],
    [body({ items: [{ cat: 'CAT-166', size: 'P', summary: 'X', description: 'x'.repeat(2001) }] }), /2000/],
    [body({ public: 'sim' }), /público/i],
  ];
  for (const [b, re] of cases) {
    const res = await t.bia.json('POST', '/api/support/templates', b);
    assert.equal(res.status, 400, JSON.stringify(b).slice(0, 80));
    assert.match((await res.json()).error, re);
  }
  assert.equal(audits(t.db).length, 0);
});

test('rotas de modelo recusam Origin externo', async () => {
  const t = await setup();
  const evil = { Origin: 'https://evil.example' };
  assert.equal((await t.bia.json('POST', '/api/support/templates', body(), evil)).status, 403);
  assert.equal((await t.json('PUT', '/api/support/templates/padrao', body(), evil)).status, 403);
  assert.equal((await t.json('DELETE', '/api/support/templates/padrao', undefined, evil)).status, 403);
  assert.equal((await t.json('GET', '/api/support/templates')).status, 200);
  assert.equal(audits(t.db).length, 0);
});

test('prévia: usa o modelo pedido (ou o último/Padrão) e aceita tarefas por épico', async () => {
  const t = await setup();
  let res = await t.json('POST', '/api/support/preview', { keys: ['BI-1', 'BI-2'] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).templateId, 'padrao');
  assert.deepEqual(t.calls[0][1], ['BI-1', 'BI-2']);
  assert.deepEqual(t.calls[0][2].items.map((i) => i.cat), ['CAT-105', 'CAT-166']);
  const { template } = await (await t.json('POST', '/api/support/templates', body())).json();
  res = await t.json('POST', '/api/support/preview', { keys: ['BI-1'], templateId: template.id, tasks: { 'BI-1': [{ cat: 'cat-105', size: 'p', summary: ' Avulsa {EPICO} ' }] } });
  assert.equal(res.status, 200);
  assert.deepEqual(t.calls[1][2], { items: template.items, tasks: { 'BI-1': [{ cat: 'CAT-105', size: 'P', summary: 'Avulsa {EPICO}', description: '' }] } });
  for (const bad of [{ tasks: { 'BI-9': [] } }, { tasks: { 'BI-1': [{ cat: 'CAT-1', size: 'P', summary: 'X' }] } }, { tasks: [] }, { templateId: 'nao-existe' }]) {
    const r = await t.json('POST', '/api/support/preview', { keys: ['BI-1'], ...bad });
    assert.ok([400, 404].includes(r.status), JSON.stringify(bad));
  }
});

test('criar: revalida CAT/tamanho e limites, repassa por épico, guarda o último modelo e audita', async () => {
  const t = await setup();
  const { template } = await (await t.bia.json('POST', '/api/support/templates', body({ public: true }))).json();
  const tasks = { 'BI-1': [{ cat: 'CAT-200', size: 'G', summary: 'Revisão {EPICO}', description: 'Texto' }, { cat: 'CAT-105', size: 'M', summary: 'Análise {EPICO}' }], 'BI-2': [] };
  const res = await t.caio.json('POST', '/api/support/create', { keys: ['BI-1', 'BI-2'], templateId: template.id, tasks });
  assert.equal(res.status, 200);
  const sent = t.calls.find((c) => c[0] === 'create');
  assert.deepEqual(sent[1], ['BI-1', 'BI-2']);
  assert.deepEqual(sent[2]['BI-1'].map((x) => [x.cat, x.size, x.summary, x.description]), [['CAT-200', 'G', 'Revisão {EPICO}', 'Texto'], ['CAT-105', 'M', 'Análise {EPICO}', '']]);
  assert.equal((await (await t.caio.json('GET', '/api/support/templates')).json()).lastUsedId, template.id);
  const [last] = audits(t.db).slice(-1);
  assert.deepEqual(last, ['support.create', { keys: ['BI-1', 'BI-2'], templateId: template.id, template: 'Meu modelo', tasks: [
    { epic: 'BI-1', cat: 'CAT-200', size: 'G', status: 'created', key: 'QSENSE-1' },
    { epic: 'BI-1', cat: 'CAT-105', size: 'M', status: 'error' },
  ] }]);
});

test('criar: entrada inválida → 400 e nada é criado nem auditado', async () => {
  const t = await setup();
  const ok = { cat: 'CAT-105', size: 'M', summary: 'T' };
  const many = Array.from({ length: 51 }, (_, i) => `BI-${i + 1}`);
  const cases = [
    { keys: [], tasks: {} },
    { keys: ['bi-1'], tasks: { 'bi-1': [ok] } },
    { keys: many, tasks: {} },
    { keys: ['BI-1 OR 1=1'], tasks: {} },
    { keys: ['BI-1'] },
    { keys: ['BI-1'], tasks: { 'BI-1': [] } },
    { keys: ['BI-1'], tasks: { 'BI-1': 'x' } },
    { keys: ['BI-1'], tasks: { 'BI-9': [ok] } },
    { keys: ['BI-1'], tasks: { 'BI-1': [{ ...ok, cat: 'CAT-999' }] } },
    { keys: ['BI-1'], tasks: { 'BI-1': [{ ...ok, size: 'G' }] } },
    { keys: ['BI-1'], tasks: { 'BI-1': [{ ...ok, summary: 'x'.repeat(256) }] } },
    { keys: ['BI-1'], tasks: { 'BI-1': Array.from({ length: 41 }, () => ok) } },
    { keys: ['BI-1'], tasks: { 'BI-1': [ok] }, templateId: 7 },
  ];
  for (const c of cases) {
    const res = await t.json('POST', '/api/support/create', c);
    assert.equal(res.status, 400, JSON.stringify(c).slice(0, 100));
  }
  assert.equal(t.calls.length, 0);
  assert.equal(audits(t.db).length, 0);
});

test('criar recusa Origin externo; aceita o do próprio app', async () => {
  const t = await setup();
  const b = { keys: ['BI-1'], tasks: { 'BI-1': [{ cat: 'CAT-105', size: 'M', summary: 'T' }] } };
  assert.equal((await t.json('POST', '/api/support/create', b, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(t.calls.length, 0);
  assert.equal((await t.json('POST', '/api/support/create', b, { Origin: t.base })).status, 200);
});

test('admin: liga e desliga "Pode criar modelos"; usuário comum recebe 403', async () => {
  const t = await setup();
  const id = t.caio.user.id;
  assert.equal((await t.caio.json('PUT', `/api/admin/usuarios/${id}/modelos`, { pode: true })).status, 403);
  assert.equal((await t.json('PUT', `/api/admin/usuarios/${id}/modelos`, { pode: 'sim' })).status, 400);
  assert.equal((await t.json('PUT', '/api/admin/usuarios/nao-existe/modelos', { pode: true })).status, 404);
  assert.equal((await t.json('PUT', `/api/admin/usuarios/${id}/modelos`, { pode: true }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await t.json('PUT', `/api/admin/usuarios/${id}/modelos`, { pode: true })).status, 200);
  assert.equal(t.users.byId(id).canCreateTemplates, true);
  const list = await (await t.json('GET', '/api/admin/usuarios')).json();
  assert.equal(list.users.find((u) => u.id === id).canCreateTemplates, true);
  assert.equal((await (await t.caio.json('GET', '/api/support/templates')).json()).canEdit, true);
  assert.equal((await t.json('PUT', `/api/admin/usuarios/${id}/modelos`, { pode: false })).status, 200);
  assert.equal(t.users.byId(id).canCreateTemplates, false);
  assert.deepEqual(audits(t.db).map(([a, d]) => [a, d]), [['admin.modelos', { userId: id, pode: true }], ['admin.modelos', { userId: id, pode: false }]]);
});

test('criar: descrição acima de 2000 é cortada, não recusa o lote', async () => {
  const t = await setup();
  const res = await t.json('POST', '/api/support/create', { keys: ['BI-1'], tasks: { 'BI-1': [{ cat: 'CAT-105', size: 'M', summary: 'T', description: 'x'.repeat(2100) }] } });
  assert.equal(res.status, 200);
  assert.equal(t.calls.find((c) => c[0] === 'create')[2]['BI-1'][0].description.length, 2000);
});

test('o modelo do sistema não pode ser excluído (nem pelo admin), mas pode ser editado', async () => {
  const t = await setup();
  const res = await t.json('DELETE', '/api/support/templates/padrao');
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Padrão.*não pode ser excluído/);
  assert.equal((await t.json('PUT', '/api/support/templates/padrao', body({ name: 'Padrão', public: true }))).status, 200);
});

test('admin: lista mostra privados alheios (usable=false), mas o padrão da prévia usa só os utilizáveis', async () => {
  const t = await setup();
  const { template: priv } = await (await t.bia.json('POST', '/api/support/templates', body({ name: 'Privado da Bia' }))).json();
  t.db.prepare('INSERT INTO user_settings (user_id, last_template_id) VALUES (?, ?)').run(t.user.id, priv.id);
  const r = await (await t.json('GET', '/api/support/templates')).json();
  assert.deepEqual(r.templates.map((x) => [x.name, x.usable]), [['Padrão', true], ['Privado da Bia', false]]);
  assert.equal(r.lastUsedId, 'padrao');
  await t.json('POST', '/api/support/preview', { keys: ['BI-1'] });
  assert.deepEqual(t.calls.at(-1)[2].items.map((i) => i.cat), ['CAT-105', 'CAT-166']);
});

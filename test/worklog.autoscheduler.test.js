import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoStore, createAutoScheduler } from '../src/worklog/auto.js';

function memFs() {
  const files = new Map();
  return {
    files,
    readFile: async (f) => { if (!files.has(f)) { const e = new Error('nf'); e.code = 'ENOENT'; throw e; } return files.get(f); },
    writeFile: async (f, t) => { files.set(f, t); },
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
}

function setup({ now = Date.parse('2026-11-10T12:30:00Z'), results = {}, disabled = false } = {}) {
  const fs = memFs();
  const store = createAutoStore({ file: 'rules.json', logFile: 'log.json', ...fs, log: () => {} });
  const calls = [];
  const service = {
    async findBySummary(text) {
      const map = { 'Daily COSARQ - BI - 10/2026': 'SIJUD-100', 'Daily COSARQ - BI - 11/2026': 'SIJUD-27633' };
      return map[text] ? { key: map[text], summary: text, available: true } : { available: false, error: `Nenhuma tarefa com o texto "${text}".` };
    },
    async describe(keys) { return keys.map((k) => (k === 'BI-77' ? { key: k, available: false, error: 'BI-77 é um épico.' } : { key: k, summary: 'Daily', available: true })); },
    async autoLog(slot) { calls.push(slot); const r = results[slot.date]; if (r instanceof Error) throw r; return r ?? { status: 'created', worklogId: `w-${slot.date}` }; },
  };
  const holidays = { async between() { return new Map([['2026-11-04', 'Feriado']]); } };
  const clock = { t: now };
  const sched = createAutoScheduler({ store, service, holidays, now: () => clock.t, disabled, log: () => {} });
  return { fs, store, service, calls, sched, clock };
}

test('tick grava os dias úteis pendentes uma única vez', async () => {
  const s = setup(); // terça 10/11 09:30 local
  await s.sched.addRule({ key: 'SIJUD-1', start: '09:00', minutes: 15, since: '2026-11-03' });
  await s.sched.tick();
  assert.deepEqual(s.calls.map((c) => c.date), ['2026-11-03', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10']);
  assert.deepEqual(s.calls[0], { taskKey: 'SIJUD-1', date: '2026-11-03', start: '09:00', minutes: 15, comment: 'Participação na reunião diária.' });
  await s.sched.tick();
  assert.equal(s.calls.length, 5, 'não repete dias já tratados');
  const st = await s.sched.status();
  assert.equal(st.rules[0].lastRun.date, '2026-11-10');
  assert.equal(st.rules[0].nextRun, '2026-11-11 09:00');
  assert.equal(st.history.length, 5);
});

test('pulado e conflito ficam como tratados; erro tenta de novo só depois de 15 min', async () => {
  const s = setup({ results: { '2026-11-06': { status: 'conflict', message: 'bate com X-1 09:00' }, '2026-11-09': { status: 'skipped', message: 'já apontado' }, '2026-11-10': new Error('HTTP 503') } });
  await s.sched.addRule({ key: 'SIJUD-1', start: '09:00', minutes: 15, since: '2026-11-06' });
  await s.sched.tick();
  assert.equal(s.calls.length, 3);
  s.clock.t += 5 * 60000;
  await s.sched.tick();
  assert.equal(s.calls.length, 3, 'erro recente não é repetido');
  s.clock.t += 11 * 60000;
  await s.sched.tick();
  assert.deepEqual(s.calls.slice(3).map((c) => c.date), ['2026-11-10']);
  const st = await s.sched.status();
  assert.deepEqual(st.history.slice(0, 2).map((h) => h.status), ['error', 'error']);
  assert.ok(st.history.some((h) => h.status === 'conflict' && h.message.includes('X-1')));
});

test('editar a regra libera os dias em conflito para nova tentativa', async () => {
  const s = setup({ results: { '2026-11-10': { status: 'conflict', message: 'x' } } });
  const r = await s.sched.addRule({ key: 'SIJUD-1', start: '09:00', minutes: 15, since: '2026-11-10' });
  await s.sched.tick();
  await s.sched.updateRule(r.id, { key: 'SIJUD-1', start: '08:00', minutes: 15, since: '2026-11-10' });
  await s.sched.tick();
  assert.deepEqual(s.calls.map((c) => c.start), ['09:00', '08:00']);
});

test('pausar tudo, regra pausada e AUTO_WORKLOG=off não gravam', async () => {
  const s = setup();
  const r = await s.sched.addRule({ key: 'SIJUD-1', start: '09:00', minutes: 15, since: '2026-11-10' });
  await s.sched.setPaused(true);
  await s.sched.tick();
  await s.sched.setPaused(false);
  await s.sched.updateRule(r.id, { key: 'SIJUD-1', start: '09:00', minutes: 15, since: '2026-11-10', enabled: false });
  await s.sched.tick();
  assert.equal(s.calls.length, 0);
  const off = setup({ disabled: true });
  await off.sched.addRule({ key: 'SIJUD-1', start: '09:00', minutes: 15, since: '2026-11-10' });
  await off.sched.tick();
  assert.equal(off.calls.length, 0);
  assert.equal((await off.sched.status()).disabled, true);
});

test('addRule confere a chave no Jira; excluir remove a regra', async () => {
  const s = setup();
  await assert.rejects(s.sched.addRule({ key: 'BI-77', start: '09:00', minutes: 15 }), /épico/);
  await assert.rejects(s.sched.addRule({ key: 'SIJUD-1', start: 'x', minutes: 15 }), RangeError);
  const r = await s.sched.addRule({ key: 'SIJUD-1', start: '09:00', minutes: 15 });
  assert.equal(r.since, '2026-11-10');
  assert.equal(JSON.parse(s.fs.files.get('rules.json')).rules.length, 1);
  await s.sched.removeRule(r.id);
  assert.deepEqual((await s.sched.status()).rules, []);
  await assert.rejects(s.sched.removeRule('nao-existe'), /não encontrada/);
});

test('arquivo de regras inválido vira lista vazia, sem derrubar o agendador', async () => {
  const s = setup();
  s.fs.files.set('rules.json', '{quebrado');
  const st = await s.sched.status();
  assert.deepEqual(st.rules, []);
  await s.sched.tick();
});

test('regra pelo texto: cada dia usa a tarefa do seu mês', async () => {
  const s = setup({ now: Date.parse('2026-11-03T18:00:00Z') }); // terça 03/11, 15:00 local
  const r = await s.sched.addRule({ summary: 'Daily COSARQ - BI - {MM/AAAA}', start: '13:30', minutes: 30, since: '2026-10-29' });
  assert.equal(r.summary, 'Daily COSARQ - BI - {MM/AAAA}');
  assert.equal(r.key, null);
  await s.sched.tick();
  assert.deepEqual(s.calls.map((c) => `${c.date} ${c.taskKey}`), ['2026-10-29 SIJUD-100', '2026-10-30 SIJUD-100', '2026-11-02 SIJUD-27633', '2026-11-03 SIJUD-27633']);
  const st = await s.sched.status();
  assert.equal(st.history.find((h) => h.date === '2026-11-03').key, 'SIJUD-27633');
});

test('regra pelo texto: mês sem tarefa avisa ao salvar e vira erro (tentado de novo depois)', async () => {
  const s = setup({ now: Date.parse('2026-12-01T18:00:00Z') }); // terça 01/12, 15:00 local
  const r = await s.sched.addRule({ summary: 'Daily COSARQ - BI - {MM/AAAA}', start: '13:30', minutes: 30, since: '2026-12-01' });
  assert.match(r.warning, /12\/2026/);
  await s.sched.tick();
  assert.equal(s.calls.length, 0);
  const st = await s.sched.status();
  assert.equal(st.history[0].status, 'error');
  assert.equal(st.history[0].key, 'Daily COSARQ - BI - 12/2026');
  assert.match(st.history[0].message, /Nenhuma tarefa/);
});

test('regra pelo texto sem mês variável e sem tarefa é recusada ao salvar', async () => {
  const s = setup();
  await assert.rejects(s.sched.addRule({ summary: 'Daily inexistente', start: '13:30', minutes: 30 }), /Nenhuma tarefa/);
  const ok = await s.sched.addRule({ summary: 'Daily COSARQ - BI - {MM/AAAA}', start: '13:30', minutes: 30 });
  assert.equal(ok.resolved.key, 'SIJUD-27633');
  assert.equal(ok.warning, undefined);
});

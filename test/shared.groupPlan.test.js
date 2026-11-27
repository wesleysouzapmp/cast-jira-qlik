// Parte 3: regras puras do wizard da tarefa agrupadora (contagem, distribuição das atividades,
// fase pela maioria, divisão por percentual e distribuição pelo calendário).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subtaskCount, shortageMessage, distributeActivities, majorityPhase, activityLine, defaultSubtaskTitle,
  subtaskDescription, groupDescription, proposeSubtasks, isValidPartition, moveActivity, splitByPercent,
  hoursProblems, planCalendar, fmtHours, DEFAULT_PERCENT,
} from '../src/shared/groupPlan.js';
import { ACTIONS, phaseOfAction } from '../src/support/actions.js';

test('quantidade de subtarefas = ⌈total ÷ 7h30⌉ (7h30 → 1; 8h → 2; 40h → 6)', () => {
  assert.equal(subtaskCount(15), 1);
  assert.equal(subtaskCount(450), 1);
  assert.equal(subtaskCount(465), 2);
  assert.equal(subtaskCount(480), 2);
  assert.equal(subtaskCount(900), 2);
  assert.equal(subtaskCount(2400), 6);
  assert.equal(subtaskCount(12000), 27);
});

test('falta de insumo: mensagem exata da spec', () => {
  assert.equal(shortageMessage(2400, 4), '40h exigem 6 subtarefas; você descreveu 4 atividades. Detalhe mais 2 atividades.');
  assert.equal(shortageMessage(480, 1), '8h exigem 2 subtarefas; você descreveu 1 atividade. Detalhe mais 1 atividade.');
  assert.equal(shortageMessage(450, 0), '7h30 exige 1 subtarefa; você descreveu 0 atividades. Detalhe mais 1 atividade.');
  assert.equal(shortageMessage(2400, 6), '');
  assert.equal(fmtHours(15), '0h15');
});

test('distribuição das atividades: em ordem, blocos seguidos, as primeiras com uma a mais', () => {
  assert.deepEqual(distributeActivities(6, 3), [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(distributeActivities(7, 3), [[0, 1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(distributeActivities(3, 3), [[0], [1], [2]]);
  assert.deepEqual(distributeActivities(5, 1), [[0, 1, 2, 3, 4]]);
  assert.equal(distributeActivities(2, 3), null);
});

test('fase da maioria das ações; empate vale a primeira', () => {
  assert.equal(majorityPhase(['analise', 'execucao', 'execucao']), 'execucao');
  assert.equal(majorityPhase(['testes', 'analise']), 'testes');
  assert.equal(majorityPhase(['analise', 'testes', 'testes', 'analise']), 'analise');
  assert.equal(majorityPhase([]), 'execucao');
});

test('ações: lista fixa ligada às fases', () => {
  assert.equal(ACTIONS.length, 15);
  assert.equal(phaseOfAction('Analisar'), 'analise');
  assert.equal(phaseOfAction('Fazer engenharia reversa'), 'execucao');
  assert.equal(phaseOfAction('Disponibilizar para validação'), 'testes');
  assert.equal(phaseOfAction('Documentar'), 'producao');
  assert.equal(phaseOfAction('Dançar'), null);
});

test('textos: linha = ação + atividade (sem repetir a ação), título e descrições numeradas', () => {
  const a = { action: 'Analisar', text: 'o script SQL e o documento de negócio' };
  assert.equal(activityLine(a), 'Analisar o script SQL e o documento de negócio');
  assert.equal(activityLine({ action: 'Analisar', text: 'analisar o script SQL' }), 'Analisar o script SQL');
  assert.equal(defaultSubtaskTitle(a), 'Analisar - o script SQL e o documento de negócio');
  assert.equal(defaultSubtaskTitle({ action: 'Criar', text: 'x'.repeat(300) }).length, 255);
  const b = { action: 'Desenvolver', text: 'as telas do painel' };
  assert.equal(subtaskDescription([a, b]), '1. Analisar o script SQL e o documento de negócio\n2. Desenvolver as telas do painel');
  assert.equal(groupDescription([a, b]), 'As atividades realizadas foram:\n1. Analisar o script SQL e o documento de negócio\n2. Desenvolver as telas do painel');
  assert.equal(groupDescription(Array.from({ length: 60 }, () => ({ action: 'Criar', text: 'y'.repeat(100) }))).length, 2000);
});

test('proposta: N subtarefas com fase, título e descrição; erro quando falta atividade', () => {
  const acts = [
    { action: 'Analisar', text: 'o script SQL', phase: 'analise' },
    { action: 'Levantar', text: 'as regras de negócio', phase: 'analise' },
    { action: 'Desenvolver', text: 'a carga nova', phase: 'execucao' },
  ];
  const { subtasks } = proposeSubtasks(acts, 480);
  assert.deepEqual(subtasks.map((s) => [s.activities, s.phase, s.summary]), [
    [[0, 1], 'analise', 'Analisar - o script SQL'],
    [[2], 'execucao', 'Desenvolver - a carga nova'],
  ]);
  assert.equal(subtasks[0].description, '1. Analisar o script SQL\n2. Levantar as regras de negócio');
  assert.match(proposeSubtasks(acts, 2400).error, /^40h exigem 6 subtarefas; você descreveu 3 atividades\. Detalhe mais 3 atividades\.$/);
});

test('partição contígua e mover atividade para a vizinha', () => {
  assert.equal(isValidPartition([[0, 1], [2]], 3), true);
  assert.equal(isValidPartition([[0], [2], [1]], 3), false);
  assert.equal(isValidPartition([[0, 1], []], 2), false);
  assert.equal(isValidPartition([[0]], 2), false);
  assert.deepEqual(moveActivity([[0, 1], [2]], 0, 1), [[0], [1, 2]]);
  assert.deepEqual(moveActivity([[0], [1, 2]], 1, -1), [[0, 1], [2]]);
  assert.equal(moveActivity([[0], [1]], 0, 1), null);
  assert.equal(moveActivity([[0, 1]], 0, 1), null);
});

test('dividir por percentual: todas as fases, 15 min e sobra para a primeira', () => {
  // 8h: Análise 48→45 (+15 da sobra), Execução 240, Testes 144→135, Produção 48→45.
  const r = splitByPercent(480, ['analise', 'execucao', 'testes', 'producao'], DEFAULT_PERCENT);
  assert.deepEqual(r.byPhase, { analise: 60, execucao: 240, testes: 135, producao: 45 });
  assert.deepEqual(r.minutes, [60, 240, 135, 45]);
  assert.equal(r.adjusted, false);
});

test('dividir por percentual: fase sem subtarefa sai e o percentual é redistribuído', () => {
  // Só Análise e Execução: 10/60 e 50/60 de 8h = 80 → 75 e 400 → 390 (+15 da sobra na primeira).
  const r = splitByPercent(480, ['analise', 'execucao'], DEFAULT_PERCENT, { cap: Infinity });
  assert.deepEqual(r.byPhase, { analise: 90, execucao: 390 });
  assert.deepEqual(r.minutes, [90, 390]);
});

test('dividir por percentual: partes iguais dentro da fase, sobra na primeira subtarefa da fase', () => {
  // 7h45 só Execução em 3 subtarefas → 155 cada → 150, 150, 150 + 15 na primeira.
  const r = splitByPercent(465, ['execucao', 'execucao', 'execucao'], DEFAULT_PERCENT);
  assert.deepEqual(r.minutes, [165, 150, 150]);
});

test('dividir por percentual: acima de 7h30 o excesso vai para as outras (mesma fase primeiro)', () => {
  // 40h em 6 subtarefas: Análise, Execução x3, Testes, Produção → Testes ficaria com 12h.
  const phases = ['analise', 'execucao', 'execucao', 'execucao', 'testes', 'producao'];
  const r = splitByPercent(2400, phases, DEFAULT_PERCENT);
  assert.equal(r.adjusted, true);
  assert.equal(r.minutes.reduce((s, m) => s + m, 0), 2400);
  assert.ok(r.minutes.every((m) => m <= 450 && m % 15 === 0), JSON.stringify(r.minutes));
  assert.deepEqual(hoursProblems(r.minutes, 2400), []);
  // Sem limite (Apontar horas), mantém os percentuais.
  assert.deepEqual(splitByPercent(2400, phases, DEFAULT_PERCENT, { cap: Infinity }).minutes, [240, 420, 390, 390, 720, 240]);
});

test('dividir por percentual: percentuais todos zerados dividem igualmente entre as fases presentes', () => {
  assert.deepEqual(splitByPercent(120, ['testes', 'producao'], { analise: 0, execucao: 0, testes: 0, producao: 0 }).minutes, [60, 60]);
});

test('regra das horas: blocos de 15, até 7h30 e soma = total', () => {
  assert.deepEqual(hoursProblems([450, 30], 480), []);
  assert.match(hoursProblems([465, 15], 480)[0], /Subtarefa 1: no máximo 7h30/);
  assert.match(hoursProblems([0, 480], 480)[0], /Subtarefa 1: informe/);
  assert.match(hoursProblems([10, 470], 480)[0], /blocos de 15/);
  assert.match(hoursProblems([240, 225], 480)[0], /7h45.*8h/);
});

test('calendário: dias úteis em sequência, limite diário e continuação no próximo dia', () => {
  // 2026-11-27 é sexta; 2026-11-30 segunda.
  const r = planCalendar({ minutes: [450, 450, 60], startDate: '2026-11-27', startTime: '08:00', dailyLimit: 480 });
  assert.deepEqual(r.entries, [
    { sub: 0, date: '2026-11-27', start: '08:00', minutes: 450 },
    { sub: 1, date: '2026-11-27', start: '15:30', minutes: 30 },
    { sub: 1, date: '2026-11-30', start: '08:00', minutes: 420 },
    { sub: 2, date: '2026-11-30', start: '15:00', minutes: 60 },
  ]);
  assert.equal(r.unallocated, 0);
});

test('calendário: pula fim de semana e feriado na data inicial e no meio', () => {
  const r = planCalendar({ minutes: [480, 120], startDate: '2026-11-28', dailyLimit: 480, holidays: new Set(['2026-11-30']) });
  assert.deepEqual(r.entries.map((e) => [e.sub, e.date, e.start, e.minutes]), [[0, '2026-12-01', '08:00', 480], [1, '2026-12-02', '08:00', 120]]);
});

test('calendário: desvia dos apontamentos que já existem e conta no limite do dia', () => {
  const busy = [{ date: '2026-11-30', startMin: 9 * 60, endMin: 10 * 60 + 7 }];
  const r = planCalendar({ minutes: [480], startDate: '2026-11-30', dailyLimit: 480, busy });
  assert.deepEqual(r.entries.map((e) => [e.date, e.start, e.minutes]), [
    ['2026-11-30', '08:00', 60],
    ['2026-11-30', '10:15', 345],
    ['2026-12-01', '08:00', 75],
  ]);
});

test('calendário: limite diário menor e hora de início própria', () => {
  const r = planCalendar({ minutes: [300], startDate: '2026-11-30', startTime: '13:00', dailyLimit: 240 });
  assert.deepEqual(r.entries.map((e) => [e.date, e.start, e.minutes]), [['2026-11-30', '13:00', 240], ['2026-12-01', '13:00', 60]]);
  // Início tarde: não cruza a meia-noite.
  const late = planCalendar({ minutes: [120], startDate: '2026-11-30', startTime: '23:00', dailyLimit: 480 });
  assert.deepEqual(late.entries.map((e) => [e.date, e.start, e.minutes]), [['2026-11-30', '23:00', 60], ['2026-12-01', '23:00', 60]]);
});

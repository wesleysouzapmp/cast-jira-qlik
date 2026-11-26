import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, QSENSE } from '../src/support/models.js';
import { epicLabel, renderModel, toAdf, buildCreateBody, matchesModel, supportTaskInfo } from '../src/support/render.js';

const [ANALISE, IMPL] = MODELS;

test('modelos na ordem esperada', () => {
  assert.deepEqual(MODELS.map((m) => m.id), ['analise', 'implementacao']);
  assert.equal(QSENSE.projectKey, 'QSENSE');
});

test('epicLabel junta chave e resumo', () => {
  assert.equal(epicLabel({ key: 'BI-1', fields: { summary: '  Painel X ' } }), 'BI-1 - Painel X');
});

test('renderModel substitui {EPICO} no modelo 1', () => {
  const issue = { key: 'BI-2931', fields: { summary: 'CEINJUR - Atualiza Painel "Julgamento"' } };
  const r = renderModel(ANALISE, issue);
  assert.equal(r.summary, 'Analise da demanda BI-2931 - CEINJUR - Atualiza Painel "Julgamento"');
  assert.equal(r.description, 'Analise da demanda BI-2931 - CEINJUR - Atualiza Painel "Julgamento". Levantamento das necessidades para execução.');
});

test('renderModel do modelo 2', () => {
  const r = renderModel(IMPL, { key: 'BI-1', fields: { summary: 'X' } });
  assert.equal(r.summary, 'Implementação da demanda BI-1 - X');
  assert.equal(r.description, 'Desenvolvimento e Testes da Demanda BI-1 - X. Criação de scripts Python, AQL e desenvolvimento de telas para atender a necessidade do usuário chave.');
});

test('resumo limitado a 255 com … e descrição intacta', () => {
  const r = renderModel(IMPL, { key: 'BI-1', fields: { summary: 'x'.repeat(400) } });
  assert.equal(r.summary.length, 255);
  assert.ok(r.summary.startsWith('Implementação da demanda BI-1 - xxx'));
  assert.ok(r.summary.endsWith('…'));
  assert.ok(r.description.includes('x'.repeat(400)));
});

test('toAdf gera documento com um parágrafo', () => {
  assert.deepEqual(toAdf('Oi'), { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Oi' }] }] });
});

test('buildCreateBody monta os campos do QSENSE com as opções resolvidas', () => {
  const opts = { customfield_10104: { id: '11927', child: { id: '11930' } }, customfield_10300: { id: '702' } };
  const b = buildCreateBody(ANALISE, { key: 'BI-1', fields: { summary: 'S' } }, 'acc-1', opts);
  assert.deepEqual(b.fields.project, { key: 'QSENSE' });
  assert.deepEqual(b.fields.issuetype, { id: '10002' });
  assert.deepEqual(b.fields.parent, { key: 'BI-1' });
  assert.deepEqual(b.fields.components, [{ id: '10013' }]);
  assert.deepEqual(b.fields.assignee, { accountId: 'acc-1' });
  assert.deepEqual(b.fields.customfield_10104, { id: '11927', child: { id: '11930' } });
  assert.deepEqual(b.fields.customfield_10300, { id: '702' });
  assert.equal(b.fields.summary, 'Analise da demanda BI-1 - S');
  assert.equal(b.fields.description.content[0].content[0].text, 'Analise da demanda BI-1 - S. Levantamento das necessidades para execução.');
});

test('buildCreateBody sem descrição não manda o campo', () => {
  const b = buildCreateBody({ summary: 'T {EPICO}', description: '' }, { key: 'BI-1', fields: { summary: 'S' } }, 'acc-1', {});
  assert.equal(b.fields.summary, 'T BI-1 - S');
  assert.equal('description' in b.fields, false);
});

test('renderModel: título com {EPICO} repetido nunca passa de 255', () => {
  const r = renderModel({ summary: '{EPICO} / {EPICO}', description: '' }, { key: 'BI-1', fields: { summary: 'x'.repeat(200) } });
  assert.ok(r.summary.length <= 255);
  assert.ok(r.summary.endsWith('…'));
  const plain = renderModel({ summary: 'Sem marcador', description: 'D' }, { key: 'BI-1', fields: { summary: 'S' } });
  assert.deepEqual(plain, { summary: 'Sem marcador', description: 'D' });
});

test('supportTaskInfo reconhece tarefa de apoio pelo CAT, pelo id do catálogo ou pelo título', () => {
  const t = (summary, cf) => ({ key: 'QSENSE-1', fields: { summary, ...(cf ? { customfield_10104: cf } : {}) } });
  const child = (id, value) => ({ id: '11927', value: 'BI', child: { id, value } });
  assert.deepEqual(supportTaskInfo(t('Qualquer', child('11930', 'CAT-105 - Realizar diagnóstico'))), { model: 'analise', cat: 'CAT-105', catLabel: 'CAT-105 - Realizar diagnóstico' });
  assert.deepEqual(supportTaskInfo(t('Revisão', child('13000', 'CAT-200 - Revisar painel'))), { model: null, cat: 'CAT-200', catLabel: 'CAT-200 - Revisar painel' });
  // Título de Análise mas outro CAT: vale o CAT.
  assert.deepEqual(supportTaskInfo(t('Analise da demanda BI-1', child('13000', 'CAT-200 - Revisar painel'))).model, null);
  // Só o id do filho (sem texto): CAT do modelo.
  assert.deepEqual(supportTaskInfo(t('X', { id: '11927', child: { id: '12117' } })), { model: 'implementacao', cat: 'CAT-166', catLabel: 'CAT-166 - Manter script de carga do Qlik Sense' });
  // Antiga sem catálogo: pelo começo do título.
  assert.deepEqual(supportTaskInfo(t('Implementação da demanda BI-1')), { model: 'implementacao', cat: 'CAT-166', catLabel: 'CAT-166 - Manter script de carga do Qlik Sense' });
  assert.equal(supportTaskInfo(t('Outra coisa')), null);
  assert.equal(supportTaskInfo(t('Outra coisa', child('99', 'Sem código'))), null);
});

test('matchesModel ignora acentos e caixa', () => {
  assert.ok(matchesModel(IMPL, 'IMPLEMENTACAO DA DEMANDA BI-1 - S'));
  assert.ok(matchesModel(ANALISE, 'Análise da demanda BI-1'));
  assert.ok(!matchesModel(ANALISE, 'Implementação da demanda BI-1'));
  assert.ok(!matchesModel(ANALISE, ''));
});

test('$ no resumo do épico não corrompe o texto', () => {
  const r = renderModel(ANALISE, { key: 'BI-1', fields: { summary: "Custo R$$ 10 e $& e $` fim $'" } });
  assert.equal(r.summary, "Analise da demanda BI-1 - Custo R$$ 10 e $& e $` fim $'");
  assert.ok(r.description.startsWith("Analise da demanda BI-1 - Custo R$$ 10 e $& e $` fim $'."));
  const long = renderModel(ANALISE, { key: 'BI-1', fields: { summary: 'R$$ ' + 'x'.repeat(400) } });
  assert.ok(long.summary.startsWith('Analise da demanda BI-1 - R$$ x'));
});

test('supportTaskInfo: CAT de Análise/Implementação com outro id de opção ainda é o modelo', () => {
  const t = { key: 'QSENSE-1', fields: { summary: 'Qualquer', customfield_10104: { id: '1', value: 'BI', child: { id: '99999', value: 'CAT-105 - Realizar diagnóstico' } } } };
  assert.deepEqual(supportTaskInfo(t), { model: 'analise', cat: 'CAT-105', catLabel: 'CAT-105 - Realizar diagnóstico' });
});

test('renderModel corta a descrição renderizada em 2000', () => {
  const r = renderModel({ summary: 'T', description: `${'d'.repeat(1990)} {EPICO}` }, { key: 'BI-1', fields: { summary: 'x'.repeat(300) } });
  assert.equal(r.description.length, 2000);
  assert.ok(r.description.endsWith('…'));
});

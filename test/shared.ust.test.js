import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readXlsxRows } from '../src/shared/xlsx.js';
import { catalogFromRows, normSize, catOf, validateItems, ustOf } from '../src/shared/ustCatalog.js';

const fixture = () => new Uint8Array(readFileSync(new URL('./fixtures/catalogo-exemplo.xlsx', import.meta.url)));

test('readXlsxRows lê a primeira planilha com textos compartilhados, números e colunas vazias', async () => {
  const rows = await readXlsxRows(fixture());
  assert.deepEqual(rows[0], [null, null, 'Tarefa', 'Tamanho', 'Descrição', 'Horas', 'UST']);
  assert.deepEqual(rows[2], ['1.1', 'CAT-103', 'Especificar requisitos', 'P', 'Documentar <revisar>', '1', '0.5']);
  assert.equal(rows[4][6], '1');
  assert.equal(rows[1][2], 'Seção 1 - Serviços & análise');
});

// Zip mínimo (sem compressão) com as partes dadas, para montar planilhas hostis nos testes.
function storedZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const [name, text] of Object.entries(files)) {
    const nb = enc.encode(name);
    const data = enc.encode(text);
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0)];
    parts.push(Uint8Array.from(local), nb, data);
    central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nb);
    offset += local.length + nb.length + data.length;
  }
  const cdSize = central.reduce((n, x) => n + x.length, 0);
  const n = Object.keys(files).length;
  const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(n), ...u16(n), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((k, x) => k + x.length, 0));
  let p = 0;
  for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}
const sheet = (rowsXml) => storedZip({ 'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rowsXml}</sheetData></worksheet>` });

test('readXlsxRows aguenta linha formatada no fim da planilha (r=1048576) sem estourar', async () => {
  const rows = await readXlsxRows(sheet('<row r="1"><c r="B1" t="inlineStr"><is><t>CAT-1</t></is></c></row><row r="1048576"/>'));
  assert.equal(rows[0][1], 'CAT-1');
});

test('readXlsxRows recusa coluna ou linha além dos limites do Excel', async () => {
  await assert.rejects(readXlsxRows(sheet('<row r="1"><c r="ZZZZZZ1"><v>1</v></c></row>')), /limites/);
  await assert.rejects(readXlsxRows(sheet('<row r="999999999"><c r="A999999999"><v>1</v></c></row>')), /limites/);
});

test('readXlsxRows recusa conteúdo descompactado grande demais', async () => {
  const big = `<row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(21 * 1024 * 1024)}</t></is></c></row>`;
  await assert.rejects(readXlsxRows(sheet(big)), /grande demais/);
});

test('readXlsxRows mantém como texto um código de caractere inválido', async () => {
  const rows = await readXlsxRows(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>a&#x110000;b</t></is></c></row>'));
  assert.equal(rows[0][0], 'a&#x110000;b');
});

test('readXlsxRows recusa arquivo que não é xlsx', async () => {
  await assert.rejects(readXlsxRows(new TextEncoder().encode('nome;ust\nCAT-1;2')), /xlsx/i);
});

test('catalogFromRows herda o CAT das linhas de baixo, lê tamanho e UST e ignora seções', async () => {
  const { items, warnings } = catalogFromRows(await readXlsxRows(fixture()));
  assert.deepEqual(items.map((i) => [i.cat, i.size, i.ust]), [
    ['CAT-103', 'P', 0.5], ['CAT-103', 'M', 0.8], ['CAT-103', 'G', 1],
    ['CAT-105', 'P', 0.4], ['CAT-105', 'M', 8],
    ['CAT-156', 'Hora', 1],
    ['CAT-146', 'G', 10],
  ]);
  assert.equal(items[0].task, 'Especificar requisitos');
  assert.equal(items[1].task, 'Especificar requisitos');
  assert.equal(items[1].description, 'Requisito descrevendo dimensão');
  assert.equal(items.at(-1).task, 'Manter Elasticsearch');
  assert.deepEqual(warnings, ['CAT-156 Hora aparece mais de uma vez com a mesma UST; mantida uma linha.']);
});

test('catalogFromRows avisa CAT + tamanho repetido com UST diferente e mantém o primeiro', () => {
  const rows = [['1', 'CAT-1', 'X', 'P', 'a', null, '1'], [null, null, null, 'P', 'b', null, '2']];
  const { items, warnings } = catalogFromRows(rows);
  assert.deepEqual(items.map((i) => i.ust), [1]);
  assert.match(warnings[0], /CAT-1 P.*UST diferentes.*1.*2/);
});

test('catalogFromRows avisa linha com CAT e tamanho mas UST ilegível; aceita notação exponencial', () => {
  const rows = [['1', 'CAT-1', 'X', 'P', 'a', null, '1,5 UST'], [null, null, null, 'M', 'b', null, '1.2E+2'], [null, null, null, 'G', 'c', null, '1.234,5']];
  const { items, warnings } = catalogFromRows(rows);
  assert.deepEqual(items.map((i) => [i.size, i.ust]), [['M', 120], ['G', 1234.5]]);
  assert.deepEqual(warnings, ['CAT-1 P: UST ilegível ("1,5 UST"); linha ignorada.']);
});

test('normSize e catOf', () => {
  assert.equal(normSize('p'), 'P');
  assert.equal(normSize(' G - Grande'), 'G');
  assert.equal(normSize('Médio'), 'M');
  assert.equal(normSize('Pequeno'), 'P');
  assert.equal(normSize('Grande'), 'G');
  assert.equal(normSize('hora'), 'Hora');
  assert.equal(normSize('XG'), null);
  assert.equal(normSize(''), null);
  assert.equal(catOf('CAT-105 - Realizar diagnóstico'), 'CAT-105');
  assert.equal(catOf('Business Intelligence › cat-166 - Manter'), 'CAT-166');
  assert.equal(catOf('sem código'), null);
});

test('validateItems recusa catálogo vazio', () => {
  assert.throws(() => validateItems([]), /vazio/);
});

test('validateItems normaliza e recusa dados inválidos', () => {
  assert.deepEqual(validateItems([{ cat: 'cat-1', size: 'p', ust: 0.5, task: ' T ', description: '' }]), [{ cat: 'CAT-1', size: 'P', ust: 0.5, task: 'T', description: '' }]);
  for (const bad of [
    'x', [{ cat: 'X-1', size: 'P', ust: 1 }], [{ cat: 'CAT-1', size: 'Z', ust: 1 }], [{ cat: 'CAT-1', size: 'P', ust: -1 }],
    [{ cat: 'CAT-1', size: 'P', ust: 'a' }], [{ cat: 'CAT-1', size: 'P', ust: 1 }, { cat: 'CAT-1', size: 'P', ust: 2 }],
    [{ cat: 'CAT-1', size: 'P', ust: 1, task: 'x'.repeat(301) }],
  ]) assert.throws(() => validateItems(bad), RangeError, JSON.stringify(bad).slice(0, 80));
  assert.throws(() => validateItems(Array.from({ length: 1001 }, (_, i) => ({ cat: `CAT-${i}`, size: 'P', ust: 1 }))), RangeError);
});

test('ustOf busca por CAT e tamanho', () => {
  const items = [{ cat: 'CAT-105', size: 'M', ust: 8 }, { cat: 'CAT-156', size: 'Hora', ust: 1 }];
  assert.equal(ustOf(items, 'CAT-105', 'M'), 8);
  assert.equal(ustOf(items, 'CAT-105', 'P'), null);
});

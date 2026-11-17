// Tarefas favoritas do "Apontar horas", guardadas em favoritos.json (na raiz do projeto):
// uma lista de chaves do Jira, ex.: ["SIJUD-1", "BI-3000"]. Gravação atômica e serializada.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export const MAX_FAVORITES = 50;
const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'favoritos.json');

export function createFavoritesStore({
  file = DEFAULT_FILE,
  readFile = (f) => fs.promises.readFile(f, 'utf8'),
  writeFile = (f, text) => fs.promises.writeFile(f, text, 'utf8'),
  rename = (a, b) => fs.promises.rename(a, b),
  log = console.warn,
} = {}) {
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function read() {
    let text;
    try {
      text = await readFile(file);
    } catch (err) {
      if (err?.code !== 'ENOENT') log(`[favoritos] não foi possível ler ${file}: ${err?.message}`);
      return [];
    }
    let data;
    try { data = JSON.parse(text); } catch (err) {
      log(`[favoritos] ${file} não é um JSON válido (${err.message}); usando lista vazia.`);
      return [];
    }
    if (!Array.isArray(data) || !data.every((k) => typeof k === 'string')) {
      log(`[favoritos] ${file} deve ser uma lista de chaves, ex.: ["SIJUD-1"]; usando lista vazia.`);
      return [];
    }
    return [...new Set(data.filter((k) => KEY_RE.test(k)))];
  }

  async function write(keys) {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(keys, null, 2)}\n`);
    await rename(tmp, file);
  }

  return {
    list: () => serial(read),
    add: (key) => serial(async () => {
      if (typeof key !== 'string' || !KEY_RE.test(key)) throw new RangeError('Chave de tarefa inválida.');
      const keys = await read();
      if (keys.includes(key)) return keys;
      if (keys.length >= MAX_FAVORITES) throw new RangeError(`No máximo ${MAX_FAVORITES} favoritos.`);
      keys.push(key);
      await write(keys);
      return keys;
    }),
    remove: (key) => serial(async () => {
      const keys = await read();
      const next = keys.filter((k) => k !== key);
      if (next.length !== keys.length) await write(next);
      return next;
    }),
  };
}

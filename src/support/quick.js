// Novo apontamento pelo painel do dia (Meus apontamentos): cria o épico (opcional), cria a tarefa
// de apoio (no épico ou solta) e aponta as horas nela, nessa ordem e na fila única do usuário.
//
// Regras de parada:
//  - Revalidação antes de gravar (épico do usuário, espaço de listSpaces, tarefa de apoio existente,
//    campos de criação do createmeta e sobreposição com as batidas do dia): erro lança
//    ScopeError/ConflictError/JiraError e nada é gravado.
//  - Erro lançado ao criar a tarefa depois do épico criado vira task.status = error (com a chave do épico).
//  - Épico falhou: nada mais é feito. Tarefa falhou: não aponta (o épico criado volta com a chave).
//  - Apontamento falhou: a tarefa criada volta com a chave e o erro.
// Resposta: { epic?: { key?, url?, status, error? }, task: { key?, url?, status, error?, warning? },
// worklog: { status, error? } }; status 'created' | 'existing' | 'error' | 'skipped'.
import { ScopeError, ConflictError } from '../worklog/service.js';
import { hhmmToMin } from '../worklog/time.js';

const fmtDate = (d) => d.split('-').reverse().join('/');

// input já validado no servidor: { epic: null | { key } | { new: { projectId, summary } },
// task: { key } | { cat, size, summary, description }, worklog: { date, start, minutes, comment } }.
export function runQuick({ supportService, worklogService }, input) {
  return supportService.exclusive(() => quickNow({ supportService, worklogService }, input));
}

async function quickNow({ supportService, worklogService }, { epic, task, worklog }) {
  // 1. Revalidação: nada foi gravado ainda.
  let parent = null;
  let space = null;
  const out = {};
  if (epic?.key) {
    const { items } = await supportService.listItems({ onlyEpics: true });
    const found = items.find((i) => i.key === epic.key);
    if (!found) throw new ScopeError(`${epic.key} não é um épico seu em aberto.`);
    parent = { key: found.key, fields: { summary: found.summary } };
    out.epic = { key: found.key, url: found.url, status: 'existing' };
  } else if (epic?.new) {
    space = (await supportService.listSpaces()).find((s) => s.id === epic.new.projectId);
    if (!space) throw new ScopeError('Espaço não encontrado ou sem permissão para criar épico nele; escolha outro.');
  }
  // Tarefa existente: só as tarefas de apoio do usuário (as mesmas que a tela oferece).
  let existing = null;
  if (task.key) {
    const { epics, loose } = await worklogService.listTasks();
    existing = [...epics.flatMap((e) => e.tasks), ...(loose ?? [])].find((t) => t.key === task.key) ?? null;
    if (!existing) throw new ScopeError(`${task.key} não é uma tarefa de apoio sua (de um épico seu em aberto ou sem épico).`);
  }
  // Campos da criação lidos antes de gravar: createmeta ou usuário fora do ar param tudo sem criar o épico.
  const prep = task.key ? null : await supportService.prepareCreate();
  await checkFree(worklogService, worklog, task.key ? [task.key] : []);

  // 2. Épico novo.
  if (space) {
    out.epic = await supportService.createEpic({ space, summary: epic.new.summary });
    if (out.epic.status !== 'created') return { ...out, task: { status: 'skipped' }, worklog: { status: 'skipped' } };
    parent = { key: out.epic.key, fields: { summary: epic.new.summary } };
  }

  // 3. Tarefa nova (ou a existente).
  if (existing) out.task = { key: existing.key, url: existing.url, status: 'existing' };
  else {
    // Erro lançado (rede, resposta inesperada) vira erro do passo: o épico criado não se perde.
    try {
      out.task = await supportService.createTask(task, parent, prep);
    } catch (err) {
      out.task = { status: 'error', error: err?.message || 'Erro ao criar a tarefa.' };
    }
    if (out.task.status !== 'created') return { ...out, worklog: { status: 'skipped' } };
  }

  // 4. Apontamento: mesmo caminho do envio de Apontar horas (checa sobreposição de novo no Jira).
  try {
    const res = await worklogService.submit({ entries: [{ taskKey: out.task.key, ...worklog }] });
    const r = res.results?.[0];
    out.worklog = r?.status === 'created' ? { status: 'created' } : { status: 'error', error: r?.error ?? 'Apontamento não gravado.' };
  } catch (err) {
    if (existing) throw err; // nada foi criado: o erro vai como resposta da rota
    out.worklog = { status: 'error', error: err.message };
  }
  return out;
}

// Sobreposição com as batidas do usuário no dia (lidas do Jira). extraKeys: issues lidas direto.
async function checkFree(worklogService, w, extraKeys) {
  const start = hhmmToMin(w.start);
  const end = start + w.minutes;
  const hit = (await worklogService.myWorklogs(w.date, w.date, extraKeys))
    .find((b) => b.date === w.date && start < hhmmToMin(b.start) + b.minutes && hhmmToMin(b.start) < end);
  if (hit) throw new ConflictError(`Sobrepõe a batida ${hit.issueKey} das ${hit.start} em ${fmtDate(w.date)}; nada foi gravado. Recarregue o painel e escolha outro horário.`);
}

// Jira simulado com estado, para os testes do apontamento (não contém testes).
export const ME = 'acc-me';
// Tipos do QSENSE no createmeta: a Tarefa de apoio e a subtarefa.
export const QSENSE_TYPES = [{ id: '10002', name: 'Tarefa', subtask: false, hierarchyLevel: 0 }, { id: '10003', name: 'Subtarefa', subtask: true, hierarchyLevel: -1 }];

// projects/projectPageSize: espaços de GET /project/search (paginado). meta: campos do createmeta da
// tarefa de apoio. failCreate(body): texto de erro para recusar um POST /issue (ou nada para criar).
export function createFakeJira({ issues = [], worklogs = {}, transitionsTo = { 'Em Execução': true }, failWorklogFor = [], failDeleteFor = [], delayMs = 0, indexLag = false, searchTz = 'local', unauthorized = false, projects = [], projectPageSize = 50, meta = [], metaByType = {}, qsenseTypes = QSENSE_TYPES, failCreate = null, nextIssue = 900 } = {}) {
  const byKey = new Map(issues.map((i) => [i.key, structuredClone(i)]));
  const wl = structuredClone(worklogs); // key → [{ id, author:{accountId}, started, timeSpentSeconds }]
  const calls = [];
  let nextWl = 100;
  const sleep = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : null);
  const ok = (data, status = 200) => ({ status, ok: true, data });

  const client = {
    async call(req) {
      calls.push(req);
      await sleep();
      const { method = 'GET', path, query = {}, body } = req;
      if (unauthorized) return { status: 401, ok: false, data: { message: 'Unauthorized (simulado)' } };
      if (path === '/rest/api/3/myself') return ok({ accountId: ME });
      if (path === '/rest/api/3/search/jql') {
        const jql = body.jql;
        let list = [];
        if (jql.includes('parent is EMPTY')) {
          list = [...byKey.values()].filter((i) => i.key.startsWith('QSENSE-') && !i.fields.parent && i.fields.customfield_10104 && !/^conclu/i.test(i.fields.status?.name ?? ''));
        } else if (jql.startsWith('assignee = currentUser()')) list = [...byKey.values()].filter((i) => i.fields.issuetype?.hierarchyLevel === 1);
        else if (jql.startsWith('project = QSENSE')) {
          const keys = jql.match(/parent in \(([^)]*)\)/)[1].split(',').map((s) => s.trim());
          list = [...byKey.values()].filter((i) => keys.includes(i.fields.parent?.key));
        } else if (jql.startsWith('parent in (')) {
          const keys = jql.match(/parent in \(([^)]*)\)/)[1].split(',').map((s) => s.trim());
          list = [...byKey.values()].filter((i) => keys.includes(i.fields.parent?.key));
        } else if (jql.startsWith('summary ~')) {
          const phrase = jql.match(/^summary ~ "\\"(.*)\\""/)[1].toLowerCase();
          list = [...byKey.values()].filter((i) => (i.fields.summary ?? '').toLowerCase().includes(phrase));
        } else if (jql.startsWith('worklogAuthor')) {
          const [, from, to] = jql.match(/worklogDate >= "([^"]+)" AND worklogDate <= "([^"]+)"/);
          // indexLag: worklogs criados via POST ainda não aparecem na busca; searchTz 'UTC': worklogDate avaliado em UTC.
          const day = (w) => (searchTz === 'UTC' ? new Date(Date.parse(w.started.replace(/([+-]dd)(dd)$/, '$1:$2'))).toISOString().slice(0, 10) : w.started.slice(0, 10));
          list = [...byKey.values()].filter((i) => (wl[i.key] ?? []).some((w) => !(indexLag && w.fresh) && w.author.accountId === ME && day(w) >= from && day(w) <= to));
        }
        return ok({ issues: list, isLast: true });
      }
      if (path === '/rest/api/3/project/search') {
        const startAt = Number(query.startAt ?? 0);
        const size = Math.min(Number(query.maxResults ?? 50), projectPageSize);
        const values = projects.slice(startAt, startAt + size);
        return ok({ startAt, maxResults: size, total: projects.length, isLast: startAt + size >= projects.length, values });
      }
      if (path === '/rest/api/3/issue/createmeta/QSENSE/issuetypes') return ok({ startAt: 0, maxResults: 100, total: qsenseTypes.length, issueTypes: qsenseTypes });
      if (path.startsWith('/rest/api/3/issue/createmeta/')) {
        const list = metaByType[path.split('/').pop()] ?? meta;
        return ok({ startAt: 0, maxResults: 100, total: list.length, fields: list });
      }
      if (path === '/rest/api/3/issue' && method === 'POST') {
        const err = failCreate?.(body);
        if (err) return { status: 400, ok: false, data: { errorMessages: [err] } };
        const f = body.fields;
        const project = f.project?.id ? projects.find((p) => String(p.id) === String(f.project.id)) : null;
        const type = project?.issueTypes?.find((t) => String(t.id) === String(f.issuetype?.id))
          ?? (f.project?.key === 'QSENSE' ? qsenseTypes.find((t) => String(t.id) === String(f.issuetype?.id) && t.subtask) : null);
        const key = `${project?.key ?? f.project?.key}-${nextIssue++}`;
        const catIn = f.customfield_10104;
        const catMeta = (metaByType[String(f.issuetype?.id)] ?? meta).find((x) => (x.fieldId ?? x.id) === 'customfield_10104')?.allowedValues ?? [];
        const child = catMeta.flatMap((o) => o.children ?? []).find((c) => String(c.id) === String(catIn?.child?.id));
        byKey.set(key, { key, fields: {
          summary: f.summary, status: { name: 'Aberto' }, assignee: f.assignee, project: { key: project?.key ?? f.project?.key },
          issuetype: type ? { name: type.name, hierarchyLevel: type.hierarchyLevel } : { name: 'Tarefa de apoio', hierarchyLevel: 0 },
          ...(f.parent ? { parent: { key: f.parent.key } } : {}), timespent: 0,
          ...(catIn ? { customfield_10104: { id: catIn.id, child: { id: catIn.child.id, value: child?.value ?? '' } } } : {}),
        } });
        return ok({ id: String(5000 + nextIssue), key }, 201);
      }
      if (path === '/rest/api/3/issue/bulkfetch') return ok({ issues: body.issueIdsOrKeys.map((k) => byKey.get(k)).filter(Boolean) });
      let m;
      if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/worklog\/(\d+)$/))) {
        const [, key, id] = m;
        const list = wl[key] ?? [];
        const idx = list.findIndex((w) => w.id === id);
        if (idx < 0) return { status: 404, ok: false, data: { errorMessages: ['Worklog não encontrado'] } };
        if (method === 'GET') return ok(list[idx]);
        if (method === 'DELETE') {
          if (failDeleteFor.includes(id)) return { status: 403, ok: false, data: { errorMessages: ['Sem permissão para apagar (simulado)'] } };
          list.splice(idx, 1);
          return { status: 204, ok: true, data: '' };
        }
        if (method === 'PUT') {
          Object.assign(list[idx], { started: body.started, timeSpent: body.timeSpent, timeSpentSeconds: toSeconds(body.timeSpent), comment: body.comment });
          return ok(list[idx]);
        }
      }
      if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/worklog$/))) {
        const key = m[1];
        if (method === 'GET') {
          const after = Number(query.startedAfter ?? 0);
          const before = Number(query.startedBefore ?? Infinity);
          const list = (wl[key] ?? []).filter((w) => { const t = Date.parse(w.started.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')); return t >= after && t < before; });
          return ok({ worklogs: list, total: list.length });
        }
        if (failWorklogFor.includes(key)) return { status: 400, ok: false, data: { errorMessages: ['Worklog recusado (simulado)'] } };
        const w = { id: String(nextWl++), fresh: true, author: { accountId: ME }, started: body.started, timeSpent: body.timeSpent, timeSpentSeconds: toSeconds(body.timeSpent), comment: body.comment };
        (wl[key] ??= []).push(w);
        return ok(w, 201);
      }
      if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/))) {
        const issue = byKey.get(m[1]);
        const available = Object.entries(transitionsTo).filter(([, on]) => on).map(([name], i) => ({ id: String(300 + i), name, to: { name } }));
        if (method === 'GET') return ok({ transitions: available });
        const t = available.find((x) => x.id === body.transition.id);
        issue.fields.status = { name: t.to.name };
        return { status: 204, ok: true, data: '' };
      }
      return { status: 404, ok: false, data: { errorMessages: [`não simulado: ${method} ${path}`] } };
    },
  };

  return { client, calls, issues: byKey, worklogs: wl };
}

function toSeconds(ts) {
  const h = Number(ts.match(/(\d+)h/)?.[1] ?? 0);
  const m = Number(ts.match(/(\d+)m/)?.[1] ?? 0);
  return (h * 60 + m) * 60;
}

export const epicIssue = (key, status = 'Em Execução', summary = 'Painel ' + key) => ({ key, fields: { summary, status: { name: status }, issuetype: { name: 'Épico', hierarchyLevel: 1 }, project: { key: 'BI' } } });
export const taskIssue = (key, parent, model, status = 'Aberto', timespent = 0) => ({
  key,
  fields: {
    summary: `${model === 'analise' ? 'Analise' : 'Implementação'} da demanda ${parent}`,
    status: { name: status },
    parent: { key: parent },
    timespent,
    issuetype: { name: 'Tarefa de apoio', hierarchyLevel: 0 },
    customfield_10104: { id: '11927', child: { id: model === 'analise' ? '11930' : '12117' } },
  },
});

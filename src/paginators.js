// Estratégias de paginação das APIs do Jira Cloud.
//   none           — uma única chamada
//   offset         — startAt/maxResults (para com isLast, total, página vazia ou curta)
//   token          — nextPageToken (search/jql, changelog/bulkfetch)
//   worklogUpdated — nextPage/lastPage (worklog/updated)

export function extractRecords(data, dataKey) {
  if (dataKey) {
    const v = data?.[dataKey];
    return Array.isArray(v) ? v : [];
  }
  if (Array.isArray(data)) return data;
  return data === undefined || data === null ? [] : [data];
}

function clone(request) {
  return {
    ...request,
    query: { ...(request.query ?? {}) },
    body: request.body ? structuredClone(request.body) : request.body ?? null,
  };
}

export function nextRequest(strategy, { data, request, records, pageSize }) {
  switch (strategy) {
    case 'offset': {
      if (records.length === 0) return null;
      if (data?.isLast === true) return null;
      const startAt = (Number(request.query?.startAt) || 0) + records.length;
      if (typeof data?.total === 'number' && startAt >= data.total) return null;
      // Respostas em array puro (ex.: users/search) podem vir com menos de maxResults
      // mesmo havendo mais páginas: só a página vazia indica o fim.
      const next = clone(request);
      next.query.startAt = startAt;
      return next;
    }
    case 'token': {
      if (!data?.nextPageToken || data?.isLast === true) return null;
      const next = clone(request);
      if (request.method === 'POST') next.body = { ...(next.body ?? {}), nextPageToken: data.nextPageToken };
      else next.query.nextPageToken = data.nextPageToken;
      return next;
    }
    case 'worklogUpdated': {
      if (data?.lastPage === true || !data?.nextPage) return null;
      const since = new URL(data.nextPage).searchParams.get('since');
      if (since === null) return null;
      const next = clone(request);
      next.query.since = since;
      return next;
    }
    default:
      return null;
  }
}

function currentToken(request) {
  return request.method === 'POST' ? request.body?.nextPageToken : request.query?.nextPageToken;
}

export async function paginate({ fetchPage, strategy, dataKey, request, maxPages = 20 }) {
  const pageSize = Number(request.query?.maxResults ?? request.body?.maxResults ?? 50);
  const pages = [];
  const records = [];
  let req = clone(request);

  for (let n = 1; ; n++) {
    const res = await fetchPage(req);
    if (!res.ok) {
      pages.push({ n, status: res.status, count: 0, ms: res.ms });
      return { pages, total: records.length, records, stoppedBy: 'error', error: res.data };
    }
    const pageRecords = extractRecords(res.data, dataKey);
    records.push(...pageRecords);
    pages.push({ n, status: res.status, count: pageRecords.length, ms: res.ms });

    const next = nextRequest(strategy, { data: res.data, request: req, records: pageRecords, pageSize });
    if (!next) return { pages, total: records.length, records, stoppedBy: 'end' };
    if (strategy === 'token' && currentToken(next) === currentToken(req)) {
      return { pages, total: records.length, records, stoppedBy: 'loop' };
    }
    if (n >= maxPages) return { pages, total: records.length, records, stoppedBy: 'maxPages' };
    req = next;
  }
}

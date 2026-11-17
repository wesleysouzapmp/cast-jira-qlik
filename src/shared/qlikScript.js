// Gera um trecho de script de carga do Qlik Sense (REST Connector) que reproduz
// a chamada e a paginação testadas no app. Roda no Node e no navegador.
//
// Observação: WITH CONNECTION aceita URL, QUERY, HTTPHEADER e BODY, mas não o método
// HTTP. Por isso endpoints POST usam uma conexão separada (<nome>_POST) criada com Method = POST.

const q = (s) => String(s).replace(/"/g, '""'); // escape dentro de "..." no SQL do conector
const sq = (s) => String(s).replace(/'/g, "''"); // escape dentro de '...' em LET

function scalarColumns(sample) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return [];
  return Object.entries(sample)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k]) => k);
}

function tableName(endpoint) {
  return 'Jira_' + endpoint.id.replace(/[^A-Za-z0-9]/g, '_');
}

export function generateQlikScript({ baseUrl, endpoint, request, sampleRecord, connectionName = 'Jira_REST' }) {
  const isPost = request.method === 'POST';
  const conn = isPost ? `${connectionName}_POST` : connectionName;
  const url = String(baseUrl).replace(/\/+$/, '') + request.path;
  const dk = endpoint.dataKey;
  const table = tableName(endpoint);
  const strategy = endpoint.pagination;

  const cols = scalarColumns(sampleRecord);
  const colList = cols.length ? cols.map((c) => `"${q(c)}"`) : ['"id"'];
  const loadCols = cols.length ? cols.map((c) => `"${q(c)}"`).join(', ') : '*';

  // Parâmetros fixos da query (sem os controlados pela paginação)
  const managed = new Set(['startAt', 'nextPageToken', ...(strategy === 'worklogUpdated' ? ['since'] : [])]);
  const queryParts = Object.entries(request.query ?? {})
    .filter(([k, v]) => !managed.has(k) && v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `QUERY "${q(k)}" "${q(v)}"`);

  // Corpo (POST)
  let bodyClause = '';
  let bodyLet = '';
  if (isPost) {
    const body = { ...(request.body ?? {}) };
    delete body.nextPageToken;
    const bodyEsc = q(JSON.stringify(body));
    if (strategy === 'token') {
      const open = bodyEsc.endsWith('}') && bodyEsc !== '{}' ? bodyEsc.slice(0, -1) + ',' : '{';
      bodyLet = `  LET vBody = If(Len('$(vNextToken)') > 0, '${sq(open)}""nextPageToken"":""$(vNextToken)""}', '${sq(bodyEsc)}');\n`;
      bodyClause = 'BODY "$(vBody)"';
    } else {
      bodyClause = `BODY "${bodyEsc}"`;
    }
  }

  const pagingQuery = {
    offset: ['QUERY "startAt" "$(vStartAt)"'],
    worklogUpdated: ['QUERY "since" "$(vSince)"'],
    token: [],
    none: [],
  }[strategy] ?? [];

  const withParts = [`URL "${q(url)}"`, ...queryParts, ...pagingQuery];
  if (isPost) withParts.push('HTTPHEADER "Content-Type" "application/json"', bodyClause);
  let withConn = withParts.join(',\n      ');
  if (strategy === 'token' && !isPost) withConn += '\n      $(vTokenClause)';

  const rootFields = { token: ['"nextPageToken"'], worklogUpdated: ['"nextPage"', '"lastPage"'] }[strategy] ?? [];
  const colLines = colList.map((c) => `        ${c},`).join('\n');

  let select;
  let pageLoad;
  if (dk) {
    select = [
      '  RestConnectorMasterTable:',
      '  SQL SELECT',
      ...rootFields.map((f) => `    ${f},`),
      '    "__KEY_root",',
      '    (SELECT',
      colLines,
      `        "__FK_${q(dk)}"`,
      `     FROM "${q(dk)}" FK "__FK_${q(dk)}")`,
      '  FROM JSON (wrap on) "root" PK "__KEY_root"',
      `  WITH CONNECTION (\n      ${withConn}\n  );`,
    ].join('\n');
    pageLoad = `  _Page:\n  NoConcatenate LOAD ${loadCols}\n  RESIDENT RestConnectorMasterTable\n  WHERE NOT IsNull([__FK_${dk}]);`;
  } else {
    select = [
      '  RestConnectorMasterTable:',
      '  SQL SELECT',
      colList.map((c) => `    ${c}`).join(',\n'),
      '  FROM JSON (wrap on) "root"',
      `  WITH CONNECTION (\n      ${withConn}\n  );`,
    ].join('\n');
    pageLoad = `  _Page:\n  NoConcatenate LOAD ${loadCols}\n  RESIDENT RestConnectorMasterTable;`;
  }

  const appendPage = [
    `  LET vRows = NoOfRows('_Page');`,
    `  IF vRows > 0 THEN`,
    `    IF IsNull(TableNumber('${table}')) THEN`,
    `      [${table}]: NoConcatenate LOAD * RESIDENT _Page;`,
    `    ELSE`,
    `      Concatenate([${table}]) LOAD * RESIDENT _Page;`,
    `    END IF`,
    `  END IF`,
    `  DROP TABLE _Page;`,
  ].join('\n');

  const header = [
    `// ===== Jira API Tester — ${endpoint.label} =====`,
    `// Endpoint: ${request.method} ${request.path}`,
    `// Conexão REST "${conn}": URL ${String(baseUrl).replace(/\/+$/, '')}, Basic Auth (e-mail + API token),`,
    `//   Method = ${isPost ? 'POST' : 'GET'} e a opção "Allow WITH CONNECTION" marcada.`,
    cols.length ? null : '// Rode a chamada no app para listar as colunas (usando "id" como exemplo).',
    `LIB CONNECT TO '${conn}';`,
    '',
  ].filter((l) => l !== null).join('\n');

  const footer = '\n\n// Ponto de partida: só colunas escalares de primeiro nível.\n// Objetos aninhados (ex.: fields.status) e tabelas-filhas: gere pelo assistente "Selecionar dados" do conector REST.\n';

  let body;
  if (strategy === 'none') {
    body = [select, pageLoad, appendPage, 'DROP TABLE RestConnectorMasterTable;'].join('\n\n');
  } else if (strategy === 'offset') {
    body = [
      'LET vStartAt = 0;',
      'LET vPage = 0;',
      'DO',
      '  LET vPage = vPage + 1;',
      select,
      pageLoad,
      'DROP TABLE RestConnectorMasterTable;'.replace(/^/, '  '),
      appendPage,
      '  LET vStartAt = vStartAt + vRows;',
      'LOOP WHILE vRows > 0 AND vPage < 1000;',
    ].join('\n');
  } else if (strategy === 'token') {
    body = [
      "LET vNextToken = '';",
      'LET vPage = 0;',
      'DO',
      '  LET vPage = vPage + 1;',
      isPost ? bodyLet.trimEnd() : `  LET vTokenClause = If(Len('$(vNextToken)') > 0, ', QUERY "nextPageToken" "$(vNextToken)"', '');`,
      select,
      pageLoad,
      appendPage,
      '  _Tok:',
      '  NoConcatenate LOAD "nextPageToken" RESIDENT RestConnectorMasterTable WHERE NOT IsNull([__KEY_root]);',
      "  LET vNextToken = Peek('nextPageToken', 0, '_Tok');",
      '  DROP TABLES _Tok, RestConnectorMasterTable;',
      "LOOP WHILE Len('$(vNextToken)') > 0 AND vPage < 1000;",
    ].join('\n');
  } else if (strategy === 'worklogUpdated') {
    body = [
      `LET vSince = ${Number(request.query?.since) || 0};  // epoch em ms (carga incremental: use a data da última carga)`,
      'LET vPage = 0;',
      'DO',
      '  LET vPage = vPage + 1;',
      select,
      pageLoad,
      appendPage,
      '  _Tok:',
      '  NoConcatenate LOAD "nextPage", Lower("lastPage") AS lastPage RESIDENT RestConnectorMasterTable WHERE NOT IsNull([__KEY_root]);',
      "  LET vLast = Peek('lastPage', 0, '_Tok');",
      "  LET vSince = SubField(SubField(Peek('nextPage', 0, '_Tok'), 'since=', 2), '&', 1);",
      '  DROP TABLES _Tok, RestConnectorMasterTable;',
      "LOOP WHILE '$(vLast)' <> 'true' AND '$(vLast)' <> '-1' AND Len('$(vSince)') > 0 AND vPage < 1000;",
    ].join('\n');
  }

  return header + body + footer;
}

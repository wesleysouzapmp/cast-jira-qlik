// Auditoria das ações que gravam no Jira ou mudam agendamentos: quem, quando, por onde
// (web | mcp | auto), o quê e um detalhe resumido em JSON.
//
// Decisões:
//  - `detail` é escolhido pelo chamador e deve conter só dados não sensíveis (chaves de
//    issue, contagens, ids de regra). Nunca tokens, cookies, senhas ou comentários.
//  - `at` em epoch ms (convenção das migrações); `via` é validado pelo CHECK da tabela.
//  - list(userId, limit) devolve do mais novo para o mais antigo; limite 1..1000 (padrão 50).
export function createAuditRepo(db, now = () => Date.now()) {
  const q = {
    insert: db.prepare('INSERT INTO audit (user_id, at, via, action, detail) VALUES (?, ?, ?, ?, ?)'),
    list: db.prepare('SELECT id, user_id, at, via, action, detail FROM audit WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?'),
  };
  return {
    log({ userId, via, action, detail }) {
      q.insert.run(userId ?? null, now(), via, String(action), detail === undefined || detail === null ? null : JSON.stringify(detail));
    },
    list(userId, limit = 50) {
      const n = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 1000);
      return q.list.all(userId, n).map((r) => ({
        id: r.id, userId: r.user_id, at: r.at, via: r.via, action: r.action,
        detail: r.detail === null ? null : JSON.parse(r.detail),
      }));
    },
  };
}

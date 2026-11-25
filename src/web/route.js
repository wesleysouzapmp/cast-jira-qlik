// Utilitários das rotas web de conta/administração: erro com status HTTP e wrapper que
// converte exceções em JSON (sem vazar detalhes internos).
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('[erro interno]', err?.message);
    res.status(500).json({ error: 'Erro interno no servidor do app.' });
  }
};

// Grava a auditoria sem derrubar a resposta. `detail` nunca leva segredos.
export function auditLog(audit, req, action, detail) {
  if (!audit) return;
  try { audit.log({ userId: req.user.id, via: 'web', action, detail }); } catch (err) { console.error('[auditoria]', err?.message); }
}

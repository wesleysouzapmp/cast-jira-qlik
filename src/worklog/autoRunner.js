// Agendador multiusuário: um createAutoScheduler por usuário (cache), cada um com a store
// do próprio usuário e um serviço que resolve o contexto VIGENTE a cada chamada (o contexto
// é reconstruído ao trocar o token ou após um 401). O tick roda só quem está ativo, com
// token 'ok' e não pausado, no máximo `concurrency` usuários ao mesmo tempo.
import { createAutoScheduler } from './auto.js';
import { autoStoreFor } from '../db/userData.js';

export const INVALID_TOKEN_MESSAGE = 'token do Jira inválido';

export function createAutoRunner({ db, users, contexts, holidays, now = () => Date.now(), disabled = false, log = console.log, audit, concurrency = 2 }) {
  const schedulers = new Map();
  let timer = null;

  function serviceFor(userId) {
    const invalid = () => users.getSecrets(userId).tokenStatus === 'invalid';
    const call = async (method, args) => {
      const user = users.byId(userId);
      const ctx = user ? contexts.forUser(user) : { missing: true };
      if (ctx.missing) throw new Error('Token do Jira não configurado.');
      let r;
      try { r = await ctx.worklogService[method](...args); } catch (err) {
        if (invalid()) throw new Error(INVALID_TOKEN_MESSAGE);
        throw err;
      }
      if (invalid() && r && (r.status === 'error' || r.available === false)) {
        return r.status === 'error' ? { ...r, message: INVALID_TOKEN_MESSAGE } : { ...r, error: INVALID_TOKEN_MESSAGE };
      }
      return r;
    };
    return {
      autoLog: (...a) => call('autoLog', a),
      findBySummary: (...a) => call('findBySummary', a),
      describe: (...a) => call('describe', a),
    };
  }

  function schedulerFor(userId) {
    let s = schedulers.get(userId);
    if (!s) {
      s = createAutoScheduler({ store: autoStoreFor(db, userId), service: serviceFor(userId), holidays, now, disabled, log });
      schedulers.set(userId, s);
    }
    return s;
  }

  async function tickUser(user) {
    const sched = schedulerFor(user.id);
    const entries = await sched.tick();
    return entries.map((e) => {
      if (e.status === 'created' && audit) {
        try { audit.log({ userId: user.id, via: 'auto', action: 'auto.worklog', detail: { ruleId: e.ruleId, key: e.key, date: e.date, worklogId: e.worklogId ?? null } }); } catch (err) { log(`[agendamentos] auditoria falhou: ${err?.message}`); }
      }
      return { ...e, userId: user.id };
    });
  }

  async function tick() {
    if (disabled) return [];
    const eligible = users.list().filter((u) => u.active && u.tokenStatus === 'ok');
    const results = eligible.map(() => []);
    let next = 0;
    const worker = async () => {
      while (next < eligible.length) {
        const i = next++;
        const u = eligible[i];
        try {
          if ((await autoStoreFor(db, u.id).readRules()).paused) continue;
          results[i] = await tickUser(u);
        } catch (err) { log(`[agendamentos] ${u.id}: falha: ${err?.message}`); }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, eligible.length)) }, worker));
    return results.flat();
  }

  return {
    tick,
    schedulerFor,
    start(intervalMs = 60000) {
      if (timer || disabled) return;
      const run = () => tick().catch((err) => log(`[agendamentos] falha: ${err?.message}`));
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

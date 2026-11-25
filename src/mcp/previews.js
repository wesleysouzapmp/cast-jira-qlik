// Prévias do MCP (gerar_previa → confirmar_previa) em memória, por usuário.
//
// createPreviewStore({ ttlMs = 30 min, now }) → { put(userId, preview) → id, take(userId, id) → preview | null }
//  - id aleatório (128 bits, base64url), impossível de adivinhar.
//  - take é de uso único para a dona; id de outro usuário, inexistente ou vencido → null
//    (o de outro usuário não é consumido, para ninguém "queimar" a prévia alheia).
//  - Uma instância para o processo todo (os servidores MCP são por requisição).
import { randomBytes } from 'node:crypto';

export function createPreviewStore({ ttlMs = 30 * 60e3, now = () => Date.now() } = {}) {
  const items = new Map(); // id → { userId, preview, expiresAt }

  function purge() {
    const t = now();
    for (const [id, it] of items) if (it.expiresAt <= t) items.delete(id);
  }

  return {
    ttlMs,
    put(userId, preview) {
      purge();
      const id = randomBytes(16).toString('base64url');
      items.set(id, { userId, preview, expiresAt: now() + ttlMs });
      return id;
    },
    take(userId, id) {
      if (typeof id !== 'string') return null;
      const it = items.get(id);
      if (!it || it.userId !== userId) return null;
      if (it.expiresAt <= now()) { items.delete(id); return null; }
      items.delete(id);
      return it.preview;
    },
  };
}

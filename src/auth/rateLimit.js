// Limitador de tentativas em janela deslizante, em memória.
// hit(key) registra uma tentativa e devolve true se ainda está dentro do limite.
export function createRateLimiter({ max = 5, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
      if (recent.length >= max) { hits.set(key, recent); return false; }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
    reset(key) { hits.delete(key); },
  };
}

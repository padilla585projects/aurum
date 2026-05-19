import type { AgentKey, Position, UserMemory, UserProfile } from './types';

export interface ContextSelection {
  portfolio: Position[] | null;  // null = no inyectar
  user: UserProfile | null;      // null = no inyectar
  facts: string[];               // solo hechos relevantes a la consulta
}

const PORTFOLIO_RE = /cartera|posici[oó]n|portfolio|activo|acci[oó]n|compra|venta|ganancia|p[eé]rdida|diversif|concentra|rentabilidad|peso|rebalance/i;
const PROFILE_RE   = /para m[ií]|mi situaci[oó]n|deber[ií]a|recomend|personaliz|capital|horizonte|edad|ingresos|broker|fiscal|impuesto|tribut/i;

export function selectContext(
  query: string,
  agentKey: AgentKey,
  portfolio: Position[],
  user: UserProfile,
  memory: UserMemory,
): ContextSelection {
  const q = query.toLowerCase();
  const words = q.split(/\W+/).filter(w => w.length > 3);

  // Portfolio: siempre para RIESGO, para los demás solo si la consulta lo pide
  const needsPortfolio =
    agentKey === 'riesgo' ||
    PORTFOLIO_RE.test(q) ||
    portfolio.some(p => q.includes(p.ticker.toLowerCase()));

  // Perfil usuario: siempre para FISCAL, para los demás solo si la consulta es personal
  const hasUserData = Object.values(user).some(v => v.trim().length > 0);
  const needsUser   = hasUserData && (agentKey === 'fiscal' || PROFILE_RE.test(q));

  // Memoria: solo los hechos que coinciden con palabras clave de la consulta
  const facts = memory.facts
    .filter(f => words.some(w => f.toLowerCase().includes(w)))
    .slice(0, 4);

  return {
    portfolio: needsPortfolio && portfolio.length > 0 ? portfolio : null,
    user:      needsUser ? user : null,
    facts,
  };
}

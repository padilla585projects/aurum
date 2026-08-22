import type { AgentKey, Position, UserMemory, UserProfile } from './types';
import type { PlanInversion } from './planes';

export type QueryIntent = 'simple' | 'live' | 'analytical' | 'comprehensive';

export interface ContextSelection {
  portfolio:    Position[] | null;
  /** Lo que compra periodicamente. La cartera dice lo que tiene; esto, hacia donde va. */
  planes:       PlanInversion[];
  /** Dinero sin invertir. Sin esto no se puede saber de cuanto dispone en total. */
  efectivo:     number;
  user:         UserProfile | null;
  facts:        string[];
  intent:       QueryIntent;
  maxTokens:    number;
  useWebSearch: boolean;
  query:        string;
}

const PORTFOLIO_RE = /cartera|posici[oó]n|portfolio|activo|acci[oó]n|compra|venta|ganancia|p[eé]rdida|diversif|concentra|rentabilidad|peso|rebalance/i;
const PROFILE_RE   = /para m[ií]|mi situaci[oó]n|deber[ií]a|recomend|personaliz|capital|horizonte|edad|ingresos|broker|fiscal|impuesto|tribut/i;

// Estos topes se eligieron con respuestas cortas en mente y cortan las largas
// a mitad de frase, que es como se ha estado quedando una consulta de analisis.
// Cortar por la mitad no ahorra: la respuesta ya se ha pagado entera y encima
// hay que repetir la pregunta.
const MAX_TOKENS: Record<QueryIntent, number> = {
  simple:        1024,
  live:          2048,
  analytical:    3072,
  comprehensive: 4096,
};

function classifyIntent(q: string, agentKey: AgentKey): QueryIntent {
  // Comprehensive: explicit deep-analysis requests
  if (/analiza.*completo|an[aá]lisis.*profundo|toda.*cartera|estrategia.*completa|en.*profundidad|informe.*completo/.test(q)) return 'comprehensive';

  // Live: needs real-time data
  if (/\bhoy\b|ahora|precio.*(de|actual)|cotiza|noticias|esta.semana|[úu]ltimos.datos|tiempo.real|mercado.est[áa]|c[oó]mo.est[áa]|briefing/.test(q)) return 'live';

  // Simple: definitional / explanatory (short query)
  if (q.length < 160 && /qu[eé]\s+(es|son)|defin|explic|c[oó]mo.funciona|diferencia.entre|para.qu[eé].sirve|qu[eé].significa/.test(q)) return 'simple';

  // RIESGO always gets analytical (no web, but needs full reasoning)
  if (agentKey === 'riesgo') return 'analytical';

  return 'analytical';
}

export function selectContext(
  query:     string,
  agentKey:  AgentKey,
  portfolio: Position[],
  user:      UserProfile,
  memory:    UserMemory,
  planes:    PlanInversion[] = [],
  efectivo:  number = 0,
): ContextSelection {
  const q     = query.toLowerCase();
  const words = q.split(/\W+/).filter(w => w.length > 3);

  const intent      = classifyIntent(q, agentKey);
  const maxTokens   = MAX_TOKENS[intent];
  const useWebSearch = intent !== 'simple' && agentKey !== 'riesgo';
  const skipContext  = intent === 'simple';

  const needsPortfolio =
    !skipContext && (
      agentKey === 'riesgo' ||
      PORTFOLIO_RE.test(q) ||
      portfolio.some(p => q.includes(p.ticker.toLowerCase()))
    );

  const hasUserData = Object.values(user).some(v => v.trim().length > 0);
  const needsUser   = !skipContext && hasUserData && (agentKey === 'fiscal' || PROFILE_RE.test(q));

  const facts = skipContext ? [] : memory.facts
    .filter(f => words.some(w => f.toLowerCase().includes(w)))
    .slice(0, 4);

  return {
    portfolio: needsPortfolio && portfolio.length > 0 ? portfolio : null,
    // Siempre: si compra 300 al mes, eso cambia cualquier consejo, se pregunte
    // lo que se pregunte.
    planes,
    efectivo,
    user:      needsUser ? user : null,
    facts,
    intent,
    maxTokens,
    useWebSearch,
    query,
  };
}

import type { Position, UserProfile } from './types';
import { callAnthropic } from './providers';
import { PROFILES, buildUserBlock } from './prompts';
import { buildLessonsBlock } from './selflearn';

export interface TradeItem {
  ticker: string;
  name:   string;
  isin:   string;
  amount: number;   // euros a invertir
  reason: string;
}

export interface InvestmentProposal {
  trades:        TradeItem[];
  rationale:     string;
  marketContext: string;
  estimates: {
    pessimistic: number;  // % total al final del horizonte
    base:        number;
    optimistic:  number;
    horizon:     number;  // años
  };
  totalAmount: number;
  generatedAt: number;
}

function buildAdvisorPrompt(
  capital:   number,
  profile:   string,
  portfolio: Position[],
  user:      UserProfile,
): string {
  const pf = PROFILES[profile];

  const existingStr = portfolio.length > 0
    ? portfolio.map(p => {
        const val = (p.shares * p.currentPrice).toFixed(0);
        return `${p.ticker}(${val}€, ${p.shares}acc)`;
      }).join(', ')
    : 'cartera vacía';

  const totalPortfolioVal = portfolio.reduce((a, p) => a + p.shares * p.currentPrice, 0);
  const userStr = buildUserBlock(user);

  const lessons = buildLessonsBlock();

  return `Eres AURUM, gestor de inversiones autónomo. El usuario quiere invertir ${capital}€ AHORA.

PERFIL DE RIESGO: ${pf.label} — ${pf.sys}
ASIGNACIÓN OBJETIVO: ${pf.alloc}
CARTERA ACTUAL: ${existingStr} (valor total: ${totalPortfolioVal.toFixed(0)}€)${userStr}${lessons}

INSTRUCCIONES:
1. Usa búsqueda web para obtener el estado actual del mercado (índices, tipos BCE/Fed, sentimiento, oportunidades)
2. Analiza si la cartera actual necesita rebalanceo y considera eso en la propuesta
3. Genera el plan óptimo para invertir los ${capital}€ y responde SOLO con JSON válido (sin texto antes ni después, sin backticks):

{
  "trades": [
    {
      "ticker": "VWCE",
      "name": "Vanguard FTSE All-World",
      "isin": "IE00B3RBWM25",
      "amount": 300,
      "reason": "core ETF global, máxima diversificación, acumulación"
    }
  ],
  "rationale": "Razonamiento de 2-3 frases explicando la estrategia y por qué es óptima para este perfil y mercado actual.",
  "marketContext": "Una frase con el estado del mercado hoy que justifica las decisiones.",
  "estimates": {
    "pessimistic": -12,
    "base": 52,
    "optimistic": 87,
    "horizon": 5
  }
}

REGLAS ESTRICTAS:
- Los importes en "trades" deben sumar exactamente ${capital}€
- Máximo 4 instrumentos si capital < 1000€, hasta 6 si capital ≥ 1000€
- Solo instrumentos disponibles en Trade Republic España
- ETFs preferidos (en orden): VWCE, XEON, SPPW, SGLN, EUNL, VUSA, XDWD, IUSE, VHYL, IEMA, ZPRV
- No dupliques posiciones existentes salvo que el rebalanceo lo justifique
- Importes mínimos: 10€ por instrumento
- Estimaciones realistas basadas en el histórico real del instrumento (no prometas rentabilidades imposibles)
- El escenario "base" debe coincidir con la rentabilidad histórica media del mix propuesto`;
}

export async function nexusInvestmentProposal(
  capital:   number,
  portfolio: Position[],
  profile:   string,
  user:      UserProfile,
): Promise<InvestmentProposal> {
  const system = buildAdvisorPrompt(capital, profile, portfolio, user);

  const raw = await callAnthropic(
    [{ role: 'user', content: `Analiza los mercados ahora y genera el plan de inversión para ${capital}€.` }],
    system,
    'claude-sonnet-4-6',
    undefined,
    2048,
    true,
  );

  // Extrae el JSON aunque Claude añada texto extra
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AURUM no pudo generar una propuesta válida. Inténtalo de nuevo.');
  const parsed = JSON.parse(match[0]) as Omit<InvestmentProposal, 'totalAmount' | 'generatedAt'>;

  return { ...parsed, totalAmount: capital, generatedAt: Date.now() };
}

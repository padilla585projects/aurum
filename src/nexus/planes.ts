/**
 * Planes de inversión periódicos: lo que compras cada mes sin pensarlo.
 *
 * La cartera dice lo que tienes; esto dice hacia dónde va. Son cosas distintas
 * y sin la segunda cualquier consejo va cojo: no es lo mismo tener 800 € en un
 * ETF que tener 800 € y estar metiendo 100 cada mes, aunque la foto de hoy sea
 * idéntica. Lo primero es una posición, lo segundo es una decisión que sigue
 * viva.
 */

export type Frecuencia = 'semanal' | 'quincenal' | 'mensual' | 'trimestral';

export interface PlanInversion {
  id: number;
  ticker: string;
  name: string;
  /** Importe de cada aportación, en euros. */
  amount: number;
  frecuencia: Frecuencia;
}

export const CLAVE_PLANES = 'aurum-planes-inversion';

/** Aportaciones al año de cada frecuencia, para poder compararlas entre sí. */
const AL_ANO: Record<Frecuencia, number> = {
  semanal: 52,
  quincenal: 26,
  mensual: 12,
  trimestral: 4,
};

/** Lo que suman todos los planes al mes, que es como la gente piensa en esto. */
export function aportacionMensual(planes: PlanInversion[]): number {
  return planes.reduce((total, p) => total + (p.amount * AL_ANO[p.frecuencia]) / 12, 0);
}

/** Para el prompt: qué compra esta persona por su cuenta, cada cuánto y cuánto suma. */
export function bloquePlanes(planes: PlanInversion[]): string {
  if (!planes.length) return '';
  const filas = planes.map(p => `- ${p.ticker} (${p.name}): ${p.amount}€ ${p.frecuencia}`);
  const mensual = Math.round(aportacionMensual(planes));
  return `## Planes de inversión periódicos\n${filas.join('\n')}\n`
    + `Aportación total: ~${mensual}€/mes.\n`
    + 'Estos compran solos: al recomendar, cuenta con que ya entra ese dinero.';
}

/** Normaliza lo que devuelva la IA o escriba el usuario. */
export function normalizarPlan(crudo: Record<string, unknown>, indice = 0): PlanInversion | null {
  const ticker = String(crudo.ticker ?? '').trim().toUpperCase();
  const amount = Number(crudo.amount ?? crudo.importe ?? 0);
  if (!ticker || !Number.isFinite(amount) || amount <= 0) return null;

  const cruda = String(crudo.frecuencia ?? crudo.frequency ?? 'mensual').toLowerCase();
  const frecuencia: Frecuencia =
    cruda.startsWith('sem') ? 'semanal'
    : cruda.startsWith('quin') ? 'quincenal'
    : cruda.startsWith('trim') ? 'trimestral'
    : 'mensual';

  return {
    id: Date.now() + indice,
    ticker,
    name: String(crudo.name ?? crudo.nombre ?? ticker).trim() || ticker,
    amount: Math.round(amount * 100) / 100,
    frecuencia,
  };
}

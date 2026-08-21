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

/**
 * Convierte a número lo que venga: «50», «50,00 €», «1.250,50», «50.00».
 *
 * Hace falta porque los importes de un broker español llevan coma decimal y
 * símbolo de euro, y `Number('50,00 €')` es NaN. Sin esto los planes se caían
 * en silencio y la pantalla decía que no había encontrado ninguno, que manda a
 * buscar el fallo en la captura en lugar de aquí.
 */
export function aNumero(valor: unknown): number {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : NaN;
  if (typeof valor !== 'string') return NaN;

  let texto = valor.replace(/[^\d.,-]/g, '').trim();
  if (!texto) return NaN;

  const ultimaComa = texto.lastIndexOf(',');
  const ultimoPunto = texto.lastIndexOf('.');

  if (ultimaComa !== -1 && ultimoPunto !== -1) {
    // Los dos: el último es el decimal y el otro separa los miles.
    texto = ultimaComa > ultimoPunto
      ? texto.replace(/\./g, '').replace(',', '.')
      : texto.replace(/,/g, '');
  } else if (ultimaComa !== -1) {
    // Solo comas: decimal si separa 1 o 2 cifras, miles si son 3.
    texto = texto.length - ultimaComa - 1 === 3
      ? texto.replace(/,/g, '')
      : texto.replace(',', '.');
  }

  const n = Number(texto);
  return Number.isFinite(n) ? n : NaN;
}

/** Normaliza lo que devuelva la IA o escriba el usuario. */
export function normalizarPlan(crudo: Record<string, unknown>, indice = 0): PlanInversion | null {
  const nombre = String(crudo.name ?? crudo.nombre ?? '').trim();
  const amount = aNumero(crudo.amount ?? crudo.importe ?? crudo.cantidad ?? 0);

  // La pantalla de planes de un broker suele enseñar el nombre del fondo y no
  // su ticker. Exigirlo tiraba planes perfectamente legibles, y el usuario solo
  // veía «no he encontrado ninguno». Si falta, se apaña con el nombre.
  let ticker = String(crudo.ticker ?? crudo.symbol ?? '').trim().toUpperCase();
  if (!ticker && nombre) {
    ticker = nombre.split(/\s+/)[0].slice(0, 12).toUpperCase();
  }

  if (!ticker || !Number.isFinite(amount) || amount <= 0) return null;

  // Se busca dentro del texto y no solo al principio: la IA devuelve tanto
  // «quincenal» como «cada dos semanas», y con `startsWith` lo segundo se
  // colaba como mensual. El orden importa — «dos semanas» contiene «semana».
  const cruda = String(crudo.frecuencia ?? crudo.frequency ?? '').toLowerCase();
  const frecuencia: Frecuencia =
    /quincen|dos semanas|bisemanal|cada 2 semanas/.test(cruda) ? 'quincenal'
    : /trimestr|cada 3 meses|cada tres meses/.test(cruda) ? 'trimestral'
    : /semanal|cada semana/.test(cruda) ? 'semanal'
    : 'mensual';

  return {
    id: Date.now() + indice,
    ticker,
    name: nombre || ticker,
    amount: Math.round(amount * 100) / 100,
    frecuencia,
  };
}

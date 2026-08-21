/**
 * Operaciones ya cerradas: lo que vendiste y con qué resultado.
 *
 * La cartera solo guarda lo que tienes ahora, así que lo vendido desaparecía
 * sin dejar rastro. Importa por dos motivos distintos: para saber cuánto llevas
 * generado de verdad, y porque una pérdida solo ahorra impuestos si hay
 * plusvalías del mismo ejercicio contra las que compensarla. Sin este registro,
 * decir «ahorras 24 €» es una suposición.
 */

import { aNumero } from './planes';

export interface Operacion {
  id: number;
  ticker: string;
  name: string;
  /** ISO corta (aaaa-mm-dd). Determina a qué ejercicio fiscal pertenece. */
  fecha: string;
  /** Lo que se ingresó al vender, en euros. */
  importe: number;
  /** Resultado de la operación: positivo plusvalía, negativo minusvalía. */
  resultado: number;
}

export const CLAVE_OPERACIONES = 'aurum-operaciones';

/** Tipo mínimo del ahorro en el IRPF español. Se usa como estimación prudente. */
const TIPO_IRPF_MINIMO = 0.19;

export interface BalanceFiscal {
  ejercicio: number;
  plusvalias: number;
  minusvalias: number;
  /** Lo que queda tras compensar unas con otras. */
  neto: number;
  /** Cuánto de las pérdidas todavía puede compensarse este año. */
  margenParaCompensar: number;
  ahorroEstimado: number;
}

/**
 * Cuentas del ejercicio: qué se ha ganado, qué se ha perdido y cuánto margen
 * queda para que una pérdida nueva sirva de algo.
 */
export function balanceDelEjercicio(operaciones: Operacion[], ejercicio: number): BalanceFiscal {
  const delAno = operaciones.filter(o => Number(o.fecha.slice(0, 4)) === ejercicio);

  const plusvalias  = delAno.filter(o => o.resultado > 0).reduce((a, o) => a + o.resultado, 0);
  const minusvalias = delAno.filter(o => o.resultado < 0).reduce((a, o) => a + Math.abs(o.resultado), 0);

  // Una pérdida solo ahorra si hay ganancia contra la que ponerla. Lo que
  // sobra se guarda para los cuatro ejercicios siguientes, pero no es ahorro
  // de este año — y decir lo contrario infla la cifra.
  const compensado = Math.min(plusvalias, minusvalias);

  return {
    ejercicio,
    plusvalias:  Math.round(plusvalias * 100) / 100,
    minusvalias: Math.round(minusvalias * 100) / 100,
    neto:        Math.round((plusvalias - minusvalias) * 100) / 100,
    margenParaCompensar: Math.max(0, Math.round((plusvalias - minusvalias) * 100) / 100),
    ahorroEstimado: Math.round(compensado * TIPO_IRPF_MINIMO * 100) / 100,
  };
}

/** Para el prompt: qué se ha cerrado este año y qué margen fiscal queda. */
export function bloqueOperaciones(operaciones: Operacion[], ejercicio: number): string {
  const delAno = operaciones.filter(o => Number(o.fecha.slice(0, 4)) === ejercicio);
  if (!delAno.length) return '';

  const b = balanceDelEjercicio(operaciones, ejercicio);
  const filas = delAno.map(o =>
    `- ${o.fecha} ${o.ticker}: ${o.resultado >= 0 ? '+' : ''}${o.resultado}€`,
  );

  return `## Operaciones cerradas en ${ejercicio}\n${filas.join('\n')}\n`
    + `Plusvalías ${b.plusvalias}€ · minusvalías ${b.minusvalias}€ · neto ${b.neto}€.\n`
    + (b.margenParaCompensar > 0
        ? `Quedan ${b.margenParaCompensar}€ de ganancia sin compensar: una pérdida nueva hasta ese importe sí ahorraría impuestos este año.`
        : 'No queda ganancia sin compensar: una pérdida nueva se guardaría para ejercicios futuros, no ahorraría nada este año.');
}

/** Normaliza lo que devuelva la IA o escriba el usuario. */
export function normalizarOperacion(crudo: Record<string, unknown>, indice = 0): Operacion | null {
  const nombre = String(crudo.name ?? crudo.nombre ?? '').trim();
  let ticker = String(crudo.ticker ?? crudo.symbol ?? '').trim().toUpperCase();
  if (!ticker && nombre) {
    ticker = nombre.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).join(' ').slice(0, 14).toUpperCase();
  }
  if (!ticker) return null;

  const resultado = aNumero(crudo.resultado ?? crudo.pnl ?? crudo.ganancia ?? 0);
  if (!Number.isFinite(resultado)) return null;

  const importe = aNumero(crudo.importe ?? crudo.amount ?? crudo.total ?? 0);

  // Sin fecha no se sabe a qué ejercicio pertenece, que es justo lo que decide
  // si compensa o no. Se asume el año en curso antes que descartar la operación.
  const fechaCruda = String(crudo.fecha ?? crudo.date ?? '').trim();
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(fechaCruda)
    ? fechaCruda
    : interpretarFecha(fechaCruda) ?? new Date().toISOString().slice(0, 10);

  return {
    id: Date.now() + indice,
    ticker,
    name: nombre || ticker,
    fecha,
    importe: Number.isFinite(importe) ? Math.round(importe * 100) / 100 : 0,
    resultado: Math.round(resultado * 100) / 100,
  };
}

/** Entiende «12/03/2026» y «12 mar 2026», que es como lo escriben los brokers. */
function interpretarFecha(texto: string): string | null {
  const dmy = texto.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (dmy) {
    const [, d, m, a] = dmy;
    const ano = a.length === 2 ? `20${a}` : a;
    return `${ano}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const texto_ = texto.toLowerCase();
  const conNombre = texto_.match(/(\d{1,2})\s*(?:de\s+)?([a-zá-ú]{3,})\.?\s*(?:de\s+)?(\d{4})/);
  if (conNombre) {
    const [, d, mes, a] = conNombre;
    const i = MESES.findIndex(m => mes.startsWith(m));
    if (i !== -1) return `${a}-${String(i + 1).padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

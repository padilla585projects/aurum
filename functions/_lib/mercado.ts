/**
 * Números de mercado calculados, no opinados.
 *
 * La diferencia con preguntarle a un modelo «¿está caro el mercado?» es que
 * esto se puede comprobar: son operaciones sobre la serie de cierres. Lo que
 * aporta la IA después es el criterio; la cifra sale de aquí.
 *
 * Nada de esto predice nada. Dice dónde está el mercado respecto a donde ha
 * estado, que es un hecho, no un pronóstico.
 */

export interface ContextoMercado {
  /** Cuántas sesiones se han usado. Con pocas, lo demás vale poco. */
  sesiones: number;
  precio: number;
  maximo: number;
  minimo: number;
  /** Cuánto ha caído desde el máximo del periodo. Siempre ≤ 0. */
  desdeMaximoPct: number;
  /** Cuánto ha subido desde el mínimo del periodo. Siempre ≥ 0. */
  desdeMinimoPct: number;
  /** Rendimiento del periodo entero. */
  periodoPct: number;
  /** Volatilidad anualizada, en porcentaje. */
  volatilidadPct: number;
  /** Dónde cae el precio de hoy dentro del rango del periodo: 0 mínimo, 100 máximo. */
  posicionEnRango: number;
}

/** Sesiones bursátiles de un año, para anualizar la volatilidad. */
const SESIONES_POR_ANO = 252;

/** Con menos de esto los números salen, pero no significan gran cosa. */
export const MINIMO_SESIONES = 20;

const redondear = (n: number, decimales = 2) => Math.round(n * 10 ** decimales) / 10 ** decimales;

/**
 * Calcula el contexto a partir de los cierres diarios, del más antiguo al más
 * reciente. Devuelve null si no hay serie suficiente: es mejor no decir nada
 * que decir algo calculado sobre cuatro datos.
 */
export function calcularContexto(cierresCrudos: (number | null)[]): ContextoMercado | null {
  const cierres = cierresCrudos.filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0);
  if (cierres.length < MINIMO_SESIONES) return null;

  const precio = cierres[cierres.length - 1];
  const maximo = Math.max(...cierres);
  const minimo = Math.min(...cierres);
  const primero = cierres[0];

  // Retornos diarios, para la volatilidad. Se usan logarítmicos porque se
  // suman entre periodos, que es lo que hace válido multiplicar por la raíz.
  const retornos: number[] = [];
  for (let i = 1; i < cierres.length; i++) {
    retornos.push(Math.log(cierres[i] / cierres[i - 1]));
  }
  const media = retornos.reduce((a, r) => a + r, 0) / retornos.length;
  const varianza = retornos.reduce((a, r) => a + (r - media) ** 2, 0) / (retornos.length - 1);
  const volatilidad = Math.sqrt(varianza * SESIONES_POR_ANO) * 100;

  const rango = maximo - minimo;

  return {
    sesiones: cierres.length,
    precio: redondear(precio),
    maximo: redondear(maximo),
    minimo: redondear(minimo),
    desdeMaximoPct: redondear(((precio - maximo) / maximo) * 100),
    desdeMinimoPct: redondear(((precio - minimo) / minimo) * 100),
    periodoPct: redondear(((precio - primero) / primero) * 100),
    volatilidadPct: redondear(volatilidad, 1),
    posicionEnRango: rango > 0 ? Math.round(((precio - minimo) / rango) * 100) : 50,
  };
}

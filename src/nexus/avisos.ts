/**
 * Avisos del asesor: qué merece que AURUM te interrumpa.
 *
 * Deliberadamente **no** hay ninguno del tipo «buen momento para comprar». Eso
 * es predecir el mercado, nadie sabe hacerlo, y un aviso así solo da falsa
 * confianza. Los de aquí son hechos comprobables sobre tu propia cartera: se
 * ha desviado del reparto que querías, tienes efectivo parado, algo se ha
 * desplomado. Cosas que puedes verificar tú mismo mirando los números.
 */

import { detectDrift, taxLossOpportunities } from './tools';
import type { Position } from './types';

export type Gravedad = 'info' | 'atencion';

export interface Aviso {
  id: string;
  gravedad: Gravedad;
  titulo: string;
  detalle: string;
}

/** Desviación a partir de la cual deja de ser ruido y conviene mirarlo. */
const DESVIACION_QUE_IMPORTA = 10;

/** Caída desde la que una posición merece una mirada, no una reacción. */
const CAIDA_QUE_IMPORTA = 20;

export function calcularAvisos(
  portfolio: Position[],
  profile: string,
  planes: string,
  efectivo = 0,
): Aviso[] {
  const avisos: Aviso[] = [];
  if (!portfolio.length) return avisos;

  // ── Sin planes escritos, el resto vale la mitad ──────────────────────────
  if (!planes.trim()) {
    avisos.push({
      id: 'sin-planes',
      gravedad: 'info',
      titulo: 'AURUM no sabe qué quieres hacer',
      detalle: 'Sin tus planes escritos solo puede comparar tu cartera contra una '
        + 'plantilla genérica. Cuéntaselos en Ajustes y todo lo que diga a partir '
        + 'de ahí irá sobre lo tuyo.',
    });
  }

  // ── Desviación del reparto objetivo ──────────────────────────────────────
  const drift = detectDrift(portfolio, profile);
  if (drift.needsRebal && drift.driftPct >= DESVIACION_QUE_IMPORTA) {
    avisos.push({
      id: 'desviacion',
      gravedad: 'atencion',
      titulo: `Tu reparto se ha ido ${Math.round(drift.driftPct)}% del objetivo`,
      detalle: `Ahora RV ${drift.current.rv}% · RF ${drift.current.rf}% · Alt ${drift.current.alt}%, `
        + `cuando buscabas RV ${drift.target.rv}% · RF ${drift.target.rf}% · Alt ${drift.target.alt}%.`,
    });
  }

  // ── Efectivo parado ──────────────────────────────────────────────────────
  const valor = portfolio.reduce((a, p) => a + p.shares * p.currentPrice, 0);
  if (efectivo > 0 && valor > 0 && efectivo / (valor + efectivo) > 0.15) {
    avisos.push({
      id: 'efectivo',
      gravedad: 'info',
      titulo: `Tienes ${Math.round(efectivo).toLocaleString('es-ES')} € sin invertir`,
      detalle: 'Es más del 15% de tu patrimonio. Puede estar bien si lo necesitas pronto '
        + '—díselo en tus planes— o puede ser dinero parado sin querer.',
    });
  }

  // ── Posiciones muy caídas ────────────────────────────────────────────────
  const caidas = portfolio.filter(p => {
    if (!p.avgPrice) return false;
    return (p.currentPrice - p.avgPrice) / p.avgPrice * 100 <= -CAIDA_QUE_IMPORTA;
  });
  if (caidas.length) {
    avisos.push({
      id: 'caidas',
      gravedad: 'info',
      titulo: caidas.length === 1
        ? `${caidas[0].ticker} cae más de un ${CAIDA_QUE_IMPORTA}%`
        : `${caidas.length} posiciones caen más de un ${CAIDA_QUE_IMPORTA}%`,
      detalle: `${caidas.map(p => p.ticker).join(', ')}. No es una señal de vender ni de comprar: `
        + 'es algo que conviene mirar y decidir a conciencia.',
    });
  }

  // ── Pérdidas compensables ────────────────────────────────────────────────
  const fiscal = taxLossOpportunities(portfolio);
  if (fiscal.savings > 0) {
    avisos.push({
      id: 'fiscal',
      gravedad: 'info',
      titulo: `Podrías ahorrar ~${Math.round(fiscal.savings).toLocaleString('es-ES')} € en impuestos`,
      detalle: 'Tienes pérdidas latentes que compensarían plusvalías. Ojo a la regla de los '
        + 'dos meses si piensas recomprar.',
    });
  }

  return avisos;
}

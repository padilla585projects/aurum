/**
 * Lectura de planes de inversión periódicos.
 *
 * Todo esto sale de un fallo real: la importación decía «no he encontrado
 * planes» cuando en realidad los había leído y los estaba tirando aquí. Un
 * importe en formato español no es un número para JavaScript, y un plan sin
 * ticker tampoco pasaba el filtro.
 */

import { describe, expect, it } from 'vitest';
import { aNumero, aportacionMensual, bloquePlanes, normalizarPlan, type PlanInversion } from '../../src/nexus/planes.ts';

describe('importes tal como los escribe un broker español', () => {
  it('lee un número a secas', () => {
    expect(aNumero(50)).toBe(50);
    expect(aNumero('50')).toBe(50);
  });

  it('lee coma decimal y símbolo de euro', () => {
    // Este era el fallo: Number('50,00 €') es NaN.
    expect(aNumero('50,00 €')).toBe(50);
    expect(aNumero('12,50€')).toBe(12.5);
  });

  it('lee punto de miles con coma decimal', () => {
    expect(aNumero('1.250,50 €')).toBe(1250.5);
  });

  it('lee el formato inglés', () => {
    expect(aNumero('1,250.50')).toBe(1250.5);
    expect(aNumero('50.00')).toBe(50);
  });

  it('distingue coma de miles de coma decimal', () => {
    expect(aNumero('1,250')).toBe(1250);   // tres cifras detrás: miles
    expect(aNumero('1,25')).toBe(1.25);    // dos cifras detrás: decimal
  });

  it('lo que no es un número no lo es', () => {
    expect(Number.isNaN(aNumero('mensual'))).toBe(true);
    expect(Number.isNaN(aNumero(''))).toBe(true);
    expect(Number.isNaN(aNumero(null))).toBe(true);
  });
});

describe('normalizar un plan', () => {
  it('acepta un plan con importe en formato español', () => {
    const p = normalizarPlan({ ticker: 'iwda', name: 'iShares Core MSCI World', amount: '100,00 €' })!;
    expect(p.ticker).toBe('IWDA');
    expect(p.amount).toBe(100);
    expect(p.frecuencia).toBe('mensual');
  });

  it('sin ticker se apaña con el nombre en vez de tirar el plan', () => {
    // La pantalla de planes de Trade Republic no enseña tickers: pone
    // «Core MSCI World USD (Acc)», «Amazon.com», «SpaceX». Exigirlo dejaba
    // la importación en «no he encontrado planes».
    const p = normalizarPlan({ ticker: '', name: 'Core MSCI World USD (Acc)', amount: '10 €' })!;
    expect(p.name).toBe('Core MSCI World USD (Acc)');
    expect(p.amount).toBe(10);
    expect(p.ticker).toBeTruthy();
  });

  it('lee una fila tal como sale en la pantalla del broker', () => {
    const p = normalizarPlan({ ticker: '', name: 'Amazon.com', amount: '10 €', frecuencia: 'Mensual' })!;
    expect(p).toMatchObject({ name: 'Amazon.com', amount: 10, frecuencia: 'mensual' });
  });

  it('entiende las frecuencias como las escribe cualquiera', () => {
    expect(normalizarPlan({ ticker: 'A', amount: 1, frecuencia: 'Semanal' })!.frecuencia).toBe('semanal');
    expect(normalizarPlan({ ticker: 'A', amount: 1, frecuencia: 'cada dos semanas (quincenal)' })!.frecuencia).toBe('quincenal');
    expect(normalizarPlan({ ticker: 'A', amount: 1, frequency: 'trimestralmente' })!.frecuencia).toBe('trimestral');
    expect(normalizarPlan({ ticker: 'A', amount: 1 })!.frecuencia).toBe('mensual');
  });

  it('un plan sin importe utilizable se descarta', () => {
    expect(normalizarPlan({ ticker: 'A', amount: 0 })).toBeNull();
    expect(normalizarPlan({ ticker: 'A', amount: 'lo que sea' })).toBeNull();
    expect(normalizarPlan({ amount: 50 })).toBeNull();
  });
});

describe('cuánto suma al mes', () => {
  const plan = (amount: number, frecuencia: PlanInversion['frecuencia']): PlanInversion =>
    ({ id: 1, ticker: 'X', name: 'X', amount, frecuencia });

  it('lo mensual va tal cual', () => {
    expect(aportacionMensual([plan(100, 'mensual')])).toBe(100);
  });

  it('compara frecuencias distintas en la misma escala', () => {
    // 52 semanas al año entre 12 meses.
    expect(aportacionMensual([plan(12, 'semanal')])).toBeCloseTo(52, 0);
    expect(aportacionMensual([plan(300, 'trimestral')])).toBe(100);
  });

  it('sin planes no suma nada', () => {
    expect(aportacionMensual([])).toBe(0);
    expect(bloquePlanes([])).toBe('');
  });

  it('el bloque para la IA dice el total mensual', () => {
    const texto = bloquePlanes([plan(100, 'mensual'), plan(300, 'trimestral')]);
    expect(texto).toContain('200€/mes');
  });
});

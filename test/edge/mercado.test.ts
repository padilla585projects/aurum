/**
 * Contexto de mercado: números que se pueden comprobar.
 *
 * La razón de que esto exista como cálculo y no como pregunta a un modelo es
 * justo que se pueda probar. Aquí se comprueba contra series construidas a
 * mano, donde la respuesta correcta se sabe de antemano.
 */

import { describe, expect, it } from 'vitest';
import { calcularContexto, MINIMO_SESIONES } from '../../functions/_lib/mercado.ts';

/** Serie plana: sin movimiento no hay volatilidad ni rango. */
const plana = (valor: number, n: number) => Array.from({ length: n }, () => valor);

describe('contexto de mercado', () => {
  it('con muy pocas sesiones no se dice nada', () => {
    // Calcular sobre cuatro datos da un número, pero no significa nada.
    expect(calcularContexto(plana(100, MINIMO_SESIONES - 1))).toBeNull();
  });

  it('una serie plana no tiene ni volatilidad ni recorrido', () => {
    const c = calcularContexto(plana(100, 60))!;
    expect(c.volatilidadPct).toBe(0);
    expect(c.desdeMaximoPct).toBe(0);
    expect(c.desdeMinimoPct).toBe(0);
    expect(c.periodoPct).toBe(0);
  });

  it('mide la caída desde el máximo del periodo', () => {
    // Sube a 200 y vuelve a 150: está un 25% por debajo del máximo.
    const serie = [...plana(100, 30), ...plana(200, 20), ...plana(150, 20)];
    const c = calcularContexto(serie)!;
    expect(c.maximo).toBe(200);
    expect(c.desdeMaximoPct).toBe(-25);
    expect(c.desdeMinimoPct).toBe(50);
  });

  it('sitúa el precio dentro del rango', () => {
    const serie = [...plana(100, 25), ...plana(200, 25), ...plana(150, 25)];
    // 150 está justo a la mitad entre 100 y 200.
    expect(calcularContexto(serie)!.posicionEnRango).toBe(50);
  });

  it('el rendimiento del periodo va de la primera a la última', () => {
    const serie = [...plana(100, 30), ...plana(50, 10), ...plana(110, 20)];
    expect(calcularContexto(serie)!.periodoPct).toBe(10);
  });

  it('más movimiento es más volatilidad', () => {
    const tranquila: number[] = [];
    const movida: number[] = [];
    for (let i = 0; i < 80; i++) {
      tranquila.push(100 + (i % 2 ? 0.5 : -0.5));
      movida.push(100 + (i % 2 ? 8 : -8));
    }
    const a = calcularContexto(tranquila)!;
    const b = calcularContexto(movida)!;
    expect(b.volatilidadPct).toBeGreaterThan(a.volatilidadPct);
  });

  it('los huecos de la serie no cuentan como sesiones', () => {
    // Yahoo devuelve null en los días sin negociación.
    const serie = [...plana(100, 40), null, null, ...plana(100, 10)];
    expect(calcularContexto(serie)!.sesiones).toBe(50);
  });

  it('un precio absurdo no envenena el cálculo', () => {
    const serie = [...plana(100, 40), 0, -5, ...plana(100, 10)];
    const c = calcularContexto(serie)!;
    expect(c.minimo).toBe(100);
    expect(c.sesiones).toBe(50);
  });
});

/**
 * Operaciones cerradas y su cuenta fiscal.
 *
 * Lo que se fija aquí es la regla que hace que «ahorras 24 €» sea verdad o
 * mentira: una pérdida solo ahorra impuestos si hay una ganancia del mismo
 * ejercicio contra la que ponerla. Lo que sobra se guarda para años futuros,
 * pero no es ahorro de este año, y contarlo como tal infla la cifra.
 */

import { describe, expect, it } from 'vitest';
import {
  balanceDelEjercicio, bloqueOperaciones, normalizarOperacion, type Operacion,
} from '../../src/nexus/operaciones.ts';

const op = (ticker: string, fecha: string, resultado: number): Operacion =>
  ({ id: Math.random(), ticker, name: ticker, fecha, importe: 0, resultado });

describe('balance del ejercicio', () => {
  it('sin operaciones no hay nada que compensar', () => {
    const b = balanceDelEjercicio([], 2026);
    expect(b).toMatchObject({ plusvalias: 0, minusvalias: 0, ahorroEstimado: 0 });
  });

  it('separa ganancias de pérdidas', () => {
    const b = balanceDelEjercicio([op('A', '2026-03-01', 500), op('B', '2026-04-01', -128)], 2026);
    expect(b.plusvalias).toBe(500);
    expect(b.minusvalias).toBe(128);
    expect(b.neto).toBe(372);
  });

  it('una pérdida sin ganancia no ahorra nada este año', () => {
    // El caso real: vender SPACEX en pérdidas sin haber realizado plusvalías.
    const b = balanceDelEjercicio([op('SPACEX', '2026-08-01', -128)], 2026);
    expect(b.ahorroEstimado).toBe(0);
    expect(b.margenParaCompensar).toBe(0);
  });

  it('el ahorro se calcula solo sobre lo que de verdad se compensa', () => {
    // 100€ de ganancia y 300€ de pérdida: solo se compensan 100.
    const b = balanceDelEjercicio([op('A', '2026-01-01', 100), op('B', '2026-02-01', -300)], 2026);
    expect(b.ahorroEstimado).toBe(19);
  });

  it('dice cuánta ganancia queda sin compensar', () => {
    const b = balanceDelEjercicio([op('A', '2026-01-01', 500), op('B', '2026-02-01', -100)], 2026);
    expect(b.margenParaCompensar).toBe(400);
  });

  it('lo de otros años no cuenta', () => {
    const b = balanceDelEjercicio([op('A', '2025-12-31', 900), op('B', '2026-01-02', -50)], 2026);
    expect(b.plusvalias).toBe(0);
    expect(b.minusvalias).toBe(50);
  });
});

describe('lo que se le cuenta a la IA', () => {
  it('sin operaciones del año no dice nada', () => {
    expect(bloqueOperaciones([op('A', '2025-05-05', 100)], 2026)).toBe('');
  });

  it('avisa de que una pérdida nueva no ahorraría nada', () => {
    const texto = bloqueOperaciones([op('A', '2026-02-01', -40)], 2026);
    expect(texto).toContain('no ahorraría nada este año');
  });

  it('dice cuánto margen queda cuando lo hay', () => {
    const texto = bloqueOperaciones([op('A', '2026-02-01', 300)], 2026);
    expect(texto).toContain('300€ de ganancia sin compensar');
  });
});

describe('normalizar una operación leída de una captura', () => {
  it('entiende importes y fechas en formato español', () => {
    const o = normalizarOperacion({ ticker: 'san', fecha: '12/03/2026', resultado: '-128,50 €' })!;
    expect(o.ticker).toBe('SAN');
    expect(o.fecha).toBe('2026-03-12');
    expect(o.resultado).toBe(-128.5);
  });

  it('entiende la fecha escrita con el mes en letra', () => {
    expect(normalizarOperacion({ ticker: 'A', fecha: '5 de marzo de 2026', resultado: 10 })!.fecha)
      .toBe('2026-03-05');
  });

  it('sin ticker se apaña con el nombre', () => {
    const o = normalizarOperacion({ name: 'Amazon.com', resultado: 30 })!;
    expect(o.ticker).toBeTruthy();
    expect(o.name).toBe('Amazon.com');
  });

  it('una operación sin nada identificable se descarta', () => {
    expect(normalizarOperacion({ resultado: 10 })).toBeNull();
  });
});

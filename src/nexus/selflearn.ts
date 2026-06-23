/**
 * Motor de auto-mejora de AURUM.
 *
 * Ciclo:
 *   1. Lee historial de recomendaciones con rendimiento real registrado.
 *   2. Usa DeepSeek-chat (más barato) para extraer lecciones concretas.
 *   3. Guarda lecciones en localStorage con nivel de confianza.
 *   4. Las lecciones se inyectan en el prompt del advisor.
 *   5. Con el tiempo, AURUM aprende qué funciona para este usuario/perfil/mercado.
 */

import { callDeepSeek } from './providers';
import { loadRecommendations } from './autonomous';

const LESSONS_KEY    = 'aurum-lessons-v1';
const MAX_LESSONS    = 12;
const LEARN_INTERVAL = 7 * 24 * 3600_000; // 1 semana

export interface Lesson {
  text:       string;
  confidence: number;   // 0-1: sube con más datos que la confirman
  derivedAt:  number;
  fromRecs:   number;   // cuántas recomendaciones base
}

export function loadLessons(): Lesson[] {
  try { const v = localStorage.getItem(LESSONS_KEY); return v ? JSON.parse(v) : []; }
  catch { return []; }
}

function saveLessons(lessons: Lesson[]): void {
  try { localStorage.setItem(LESSONS_KEY, JSON.stringify(lessons.slice(-MAX_LESSONS))); } catch {}
}

function lastLearningAt(): number {
  const ls = loadLessons();
  return ls.length ? Math.max(...ls.map(l => l.derivedAt)) : 0;
}

/** Bloque de lecciones para el prompt del advisor. Solo lecciones de alta confianza. */
export function buildLessonsBlock(): string {
  const lessons = loadLessons().filter(l => l.confidence >= 0.65);
  if (!lessons.length) return '';
  return (
    '\n\n## Aprendizaje acumulado (basado en rendimiento real)\n' +
    lessons.map(l => `- ${l.text}`).join('\n') +
    '\nAplica estas lecciones en tu próxima recomendación.'
  );
}

/**
 * Ejecuta el ciclo de aprendizaje asíncrono.
 * No bloquea la UI. Se llama desde autonomous.ts.
 */
export async function runLearningCycle(): Promise<void> {
  // Solo correr una vez por semana para ahorrar tokens
  if (Date.now() - lastLearningAt() < LEARN_INTERVAL) return;

  const recs = loadRecommendations().filter(r => r.actualReturn !== undefined && r.executed);
  if (recs.length < 2) return;

  const summary = recs.slice(-10).map(r => {
    const diff = ((r.actualReturn ?? 0) - (r.estimatedReturn ?? 0)).toFixed(1);
    const sign = parseFloat(diff) >= 0 ? '+' : '';
    return `Perfil:${r.profile} Estimado:${r.estimatedReturn}% Real:${r.actualReturn}% Diff:${sign}${diff}% Activos:${r.trades.map(t => t.ticker).join(',')}`;
  }).join('\n');

  try {
    const raw = await callDeepSeek(
      [{
        role: 'user',
        content:
          `Analiza este historial de recomendaciones de inversión y extrae máximo 3 lecciones CONCRETAS y accionables ` +
          `para mejorar futuras recomendaciones. Céntrate en: qué activos funcionaron mejor, qué perfiles tuvieron ` +
          `mejores resultados, y qué patrones se repiten.\n\n${summary}\n\n` +
          `Formato: una frase por línea, sin prefijos, directo y práctico.`,
      }],
      'Extractor de lecciones de inversión. Responde solo con las lecciones, sin introducción.',
      'deepseek-chat',
      400,  // máximo 400 tokens — solo necesitamos frases cortas
    );

    const newLessons: Lesson[] = raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 20 && l.length < 200)
      .slice(0, 3)
      .map(text => ({
        text,
        confidence: Math.min(0.95, 0.65 + recs.length * 0.03),
        derivedAt:  Date.now(),
        fromRecs:   recs.length,
      }));

    if (!newLessons.length) return;

    // Fusionar con lecciones existentes — eliminar duplicados similares
    const existing = loadLessons();
    const merged   = [...existing, ...newLessons]
      .filter((l, i, arr) => arr.findIndex(x => x.text.slice(0, 40) === l.text.slice(0, 40)) === i)
      .sort((a, b) => b.confidence - a.confidence);

    saveLessons(merged);
  } catch {}
}

/** Borra todas las lecciones (reset del aprendizaje). */
export function clearLessons(): void {
  try { localStorage.removeItem(LESSONS_KEY); } catch {}
}

import type { ChatMessage, UserMemory } from './types';
import { callDeepSeek } from './providers';
import * as store from '../store/state';

const MEMORY_KEY = 'aurum-nexus-memory-v1';
const EMPTY: UserMemory = { facts: [], interactions: 0, lastUpdated: 0 };

export async function loadMemory(): Promise<UserMemory> {
  return store.get<UserMemory>(MEMORY_KEY, EMPTY);
}

export async function saveMemory(m: UserMemory): Promise<void> {
  store.set(MEMORY_KEY, m);
}

export async function clearMemory(): Promise<void> {
  store.remove(MEMORY_KEY);
}

// Uses DeepSeek-chat (cheapest) to extract key facts about the user from recent messages.
// Called asynchronously every 5 interactions — never blocks the UI.
export async function extractFacts(
  messages: ChatMessage[],
  existing: UserMemory,
): Promise<UserMemory> {
  if (messages.length < 6) return existing;

  const conv = messages
    .slice(-10)
    .map(m => {
      const label = m.role === 'user' ? 'Usuario' : 'IA';
      const txt   = typeof m.content === 'string' ? m.content.slice(0, 250) : '[adjunto]';
      return `${label}: ${txt}`;
    })
    .join('\n');

  try {
    const raw = await callDeepSeek(
      [{
        role: 'user',
        content:
          `Del siguiente chat, extrae máximo 3 hechos nuevos y concretos sobre el usuario (activos que posee, capital disponible, objetivos de inversión, aversión al riesgo, horizonte temporal, situación fiscal, broker usado). ` +
          `Si no hay hechos financieramente relevantes, responde exactamente "ninguno". ` +
          `Una línea por hecho, sin prefijos ni numeración:\n\n${conv}`,
      }],
      'Eres un extractor conciso de perfiles financieros. Responde solo con los hechos relevantes o "ninguno".',
      'deepseek-chat',
    );

    const newFacts = raw
      .split('\n')
      .map(f => f.trim())
      .filter(f => f && f.toLowerCase() !== 'ninguno' && f.length > 10);

    const merged = [...new Set([...existing.facts, ...newFacts])].slice(-12);
    const updated: UserMemory = {
      facts: merged,
      interactions: existing.interactions,
      lastUpdated: Date.now(),
    };
    await saveMemory(updated);
    return updated;
  } catch {
    return existing;
  }
}

export function buildMemoryBlock(memory: UserMemory): string {
  if (!memory.facts.length) return '';
  return (
    '\n\n## Contexto del usuario (memoria persistente)\n' +
    memory.facts.map(f => `- ${f}`).join('\n') +
    '\nUsa este contexto para personalizar y enriquecer tus respuestas. No menciones que tienes esta memoria a menos que te pregunten.'
  );
}

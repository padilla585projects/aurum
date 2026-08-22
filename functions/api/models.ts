/**
 * GET /api/models?provider=x — catálogo de modelos del proveedor.
 *
 * Se consulta en vivo con la clave configurada, en lugar de mantener una lista
 * en el código. El catálogo de estos servicios cambia constantemente —los
 * modelos gratuitos de OpenRouter aparecen y desaparecen— y una lista fija
 * envejece mal y en silencio.
 *
 * La respuesta no incluye ninguna credencial: solo identificadores de modelo y,
 * cuando el proveedor los publica, precio y contexto.
 */

import type { Env, PagesContext, SessionUser } from '../_lib/types.ts';
import { fail, json } from '../_lib/http.ts';
import { PROVIDERS, isProvider, resolveCredentials, type Provider } from '../_lib/ai-proxy.ts';

/** De dónde sale el catálogo de cada proveedor. */
const CATALOGO: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com/v1/models',
  openai: 'https://api.openai.com/v1/models',
  deepseek: 'https://api.deepseek.com/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
  grok: 'https://api.x.ai/v1/models',
  // Publico: no hace falta clave para listarlo, y ademas trae precios.
  openrouter: 'https://openrouter.ai/api/v1/models',
};

export interface ModeloDisponible {
  id: string;
  nombre: string;
  /** Precio por millon de tokens, cuando el proveedor lo publica. */
  entrada: number | null;
  salida: number | null;
  contexto: number | null;
  gratuito: boolean;
}

interface FilaCatalogo {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
}

function numero(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function normalizar(fila: FilaCatalogo): ModeloDisponible | null {
  const id = typeof fila.id === 'string' ? fila.id : '';
  if (!id) return null;

  // OpenRouter da el precio por token; se muestra por millon, que es como lo
  // publica todo el mundo.
  const entrada = numero(fila.pricing?.prompt);
  const salida = numero(fila.pricing?.completion);

  return {
    id,
    nombre: typeof fila.name === 'string' ? fila.name
      : typeof fila.display_name === 'string' ? fila.display_name
      : id,
    entrada: entrada === null ? null : entrada * 1_000_000,
    salida: salida === null ? null : salida * 1_000_000,
    contexto: numero(fila.context_length),
    gratuito: entrada === 0 && salida === 0,
  };
}

/** true si el modelo sirve para conversar: entra texto y sale texto. */
function esDeTexto(fila: FilaCatalogo): boolean {
  const arq = fila.architecture;
  if (!arq) return true; // el proveedor no lo dice: no se descarta
  const entrada = Array.isArray(arq.input_modalities) ? arq.input_modalities as string[] : null;
  const salida = Array.isArray(arq.output_modalities) ? arq.output_modalities as string[] : null;
  if (salida && !salida.includes('text')) return false;
  if (entrada && !entrada.includes('text')) return false;
  return true;
}

export async function listarModelos(
  env: Env,
  user: SessionUser,
  provider: Provider,
): Promise<ModeloDisponible[] | null> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  // OpenRouter publica su catalogo sin autenticacion; el resto exige la clave.
  if (provider !== 'openrouter') {
    const credenciales = await resolveCredentials(env, user, provider);
    if (!credenciales) return null;
    if (PROVIDERS[provider].auth === 'anthropic') {
      headers['x-api-key'] = credenciales.key;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${credenciales.key}`;
    }
  }

  const res = await fetch(CATALOGO[provider], { headers });
  if (!res.ok) return null;

  const payload = (await res.json()) as { data?: FilaCatalogo[]; models?: FilaCatalogo[] };
  const filas = payload.data ?? payload.models ?? [];

  return filas
    .filter(esDeTexto)
    .map(normalizar)
    .filter((m): m is ModeloDisponible => m !== null)
    .sort((a, b) => {
      // Primero los gratuitos, y dentro de cada grupo los mas baratos.
      if (a.gratuito !== b.gratuito) return a.gratuito ? -1 : 1;
      return (a.salida ?? Infinity) - (b.salida ?? Infinity);
    });
}

/**
 * Modelo que elige el modo automatico.
 *
 * Con precios publicados —solo OpenRouter los da— se elige el mas barato que
 * sirva para conversar. Sin ellos habia que rendirse, y eso dejaba «auto»
 * inservible en OpenAI, Gemini, Grok y DeepSeek: cuatro de cinco proveedores
 * respondian 503 en cuanto se les ponia en automatico.
 *
 * Asi que sin precios se recurre al nombre, que es la unica pista que dan sus
 * catalogos. No es elegante, pero se actualiza solo con el catalogo del
 * proveedor —a diferencia de una lista fija en el codigo, que envejece— y
 * cualquier eleccion es mejor que no poder contestar.
 */
const CONTEXTO_MINIMO = 32_000;

/**
 * Nombres de la gama barata de cada casa, del mas economico al menos. Se
 * comparan sobre el identificador del modelo, en minusculas.
 */
const GAMA_ECONOMICA = ['mini', 'flash', 'haiku', 'lite', 'small', 'turbo'];

/**
 * Gamas que salen baratas y no sirven para esto.
 *
 * `gpt-5-nano` es de razonamiento: con el presupuesto de tokens de una
 * conversacion normal se lo gasta entero pensando y devuelve un texto vacio.
 * Elegirlo por barato daba respuestas en blanco, que es peor que un error.
 */
const GAMA_DESCARTADA = ['nano'];

/** Lo que no sirve para conversar aunque aparezca en el catalogo. */
const NO_CONVERSACIONAL = [
  'embed', 'whisper', 'tts', 'dall-e', 'moderation', 'audio', 'realtime',
  'image', 'vision-preview', 'transcribe', 'search', 'rerank', 'guard',
];

function sirveParaConversar(id: string): boolean {
  const bajo = id.toLowerCase();
  if (NO_CONVERSACIONAL.some(p => bajo.includes(p))) return false;
  return !GAMA_DESCARTADA.some(p => bajo.includes(p));
}

export function elegirAutomatico(modelos: ModeloDisponible[]): ModeloDisponible | null {
  const conversacionales = modelos.filter(m => sirveParaConversar(m.id));
  if (conversacionales.length === 0) return null;

  // Camino bueno: hay precios, se elige por dinero.
  const conPrecio = conversacionales.filter(m => m.salida !== null && (m.contexto ?? 0) >= CONTEXTO_MINIMO);
  if (conPrecio.length > 0) {
    return conPrecio.reduce((mejor, m) => {
      const masBarato = (m.salida ?? Infinity) < (mejor.salida ?? Infinity);
      const igualDePrecioYMayor = (m.salida ?? Infinity) === (mejor.salida ?? Infinity)
        && (m.contexto ?? 0) > (mejor.contexto ?? 0);
      return masBarato || igualDePrecioYMayor ? m : mejor;
    });
  }

  // Sin precios: se busca la gama barata por su nombre, en orden de preferencia.
  for (const gama of GAMA_ECONOMICA) {
    const candidatos = conversacionales.filter(m => m.id.toLowerCase().includes(gama));
    if (candidatos.length > 0) {
      // Entre los de la misma gama, el de identificador mas corto suele ser el
      // estable —«gpt-5-mini» frente a «gpt-5-mini-2026-03-11-preview»—, y un
      // alias estable envejece mejor que una fecha concreta.
      return candidatos.reduce((mejor, m) => (m.id.length < mejor.id.length ? m : mejor));
    }
  }

  // Ni precios ni gama reconocible: el primero que sirva para hablar. El
  // catalogo ya viene ordenado por el proveedor, y contestar con algo es mejor
  // que no contestar.
  return conversacionales[0];
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const provider = new URL(request.url).searchParams.get('provider');
  if (!isProvider(provider)) return fail(400, 'bad_provider', 'Proveedor desconocido.');

  let modelos: ModeloDisponible[] | null;
  try {
    modelos = await listarModelos(env, user, provider);
  } catch {
    modelos = null;
  }

  if (modelos === null) {
    return fail(
      502,
      'catalog_unavailable',
      `No se ha podido leer el catálogo de ${PROVIDERS[provider].label}. Comprueba que la clave sea válida.`,
    );
  }

  const automatico = elegirAutomatico(modelos);

  return json(
    {
      models: modelos,
      // Se devuelve a que resuelve el modo automatico para que la pantalla lo
      // enseñe: un «Auto» que no dice que ha elegido es una caja negra.
      auto: automatico ? { id: automatico.id, salida: automatico.salida } : null,
      // Solo tiene sentido ofrecerlo donde hay precios que comparar.
      autoDisponible: modelos.some(m => m.salida !== null),
    },
    { status: 200 },
    { 'Cache-Control': 'private, max-age=300' },
  );
}

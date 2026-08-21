/**
 * Capturas que llegan compartidas desde otra aplicación del móvil.
 *
 * Existe porque integrar un navegador dentro de AURUM para capturar el broker
 * solo se puede hacer de forma insegura: Chrome Custom Tabs no deja mirar
 * dentro —y esa protección es justo lo que hace seguro meter ahí un banco— y un
 * WebView propio significaría que el acceso al broker ocurre dentro de una
 * vista que controla esta aplicación. Así que el navegador se queda donde está
 * y solo viaja la captura, cuando el usuario decide compartirla.
 *
 * En web no hay nada de esto: el plugin no existe y todo devuelve null.
 */

export interface Captura {
  b64: string;
  tipo: string;
}

/** Aviso de que ha llegado una con la aplicación ya abierta. */
export const EVENTO_CAPTURA = 'aurum-captura-compartida';

// Quien la recibe y quien la pinta no coinciden en el tiempo: la pestaña de
// Cartera puede tardar en montarse. Se deja aquí hasta que alguien la recoja.
let pendiente: Captura | null = null;
let motivoFallo: string | null = null;

export function dejar(captura: Captura): void {
  pendiente = captura;
  motivoFallo = null;
}

/** Guarda por qué no se pudo usar una captura que sí llegó. */
export function dejarFallo(motivo: string): void {
  motivoFallo = motivo;
  pendiente = null;
}

export function tomarFallo(): string | null {
  const motivo = motivoFallo;
  motivoFallo = null;
  return motivo;
}

/** Devuelve la captura y la borra: se entrega una sola vez. */
export function tomar(): Captura | null {
  const captura = pendiente;
  pendiente = null;
  return captura;
}

export interface Recogida {
  captura: Captura | null;
  /** Llegó una captura pero no se pudo leer, y hay que decir por qué. */
  fallo: string | null;
}

/** Pregunta a Android si hay una captura compartida esperando. */
export async function recogerDelSistema(): Promise<Recogida> {
  const plugin = (window as unknown as {
    Capacitor?: { Plugins?: { CapturaCompartida?: { recoger: () => Promise<{ hay: boolean; b64?: string; tipo?: string; fallo?: string }> } } };
  }).Capacitor?.Plugins?.CapturaCompartida;

  if (!plugin) return { captura: null, fallo: null };

  try {
    const r = await plugin.recoger();
    if (r?.hay && r.b64) return { captura: { b64: r.b64, tipo: r.tipo || 'image/png' }, fallo: null };
    return { captura: null, fallo: r?.fallo ?? null };
  } catch {
    // El puente falla en raras ocasiones; no es motivo para molestar a nadie.
    return { captura: null, fallo: null };
  }
}

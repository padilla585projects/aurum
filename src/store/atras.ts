/**
 * Qué hace el botón atrás del móvil.
 *
 * AURUM es una aplicación de pestañas sin historial de navegación, así que el
 * botón atrás no tenía a dónde ir: se quedaba quieto y ni cerraba lo abierto ni
 * dejaba salir. Lo que hace falta es un orden — cerrar lo que esté encima,
 * luego volver a la pestaña principal, y solo entonces salir.
 *
 * Se lleva con una pila porque quien sabe qué hay que cerrar es cada ventana,
 * no la aplicación entera: la que se abre la última es la primera en cerrarse.
 */

type Manejador = () => void;

const pila: Manejador[] = [];

/**
 * Registra qué hacer con el botón atrás mientras esto esté abierto.
 * Devuelve la función de quitarlo, para usarla al desmontar.
 */
export function registrar(manejador: Manejador): () => void {
  pila.push(manejador);
  return () => {
    const i = pila.lastIndexOf(manejador);
    if (i !== -1) pila.splice(i, 1);
  };
}

/**
 * Ejecuta el manejador de más arriba. Devuelve si había alguno: si no, le toca
 * decidir a la aplicación —cambiar de pestaña o salir.
 */
export function atender(): boolean {
  const manejador = pila[pila.length - 1];
  if (!manejador) return false;
  manejador();
  return true;
}

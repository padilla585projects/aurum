package com.aurum.advisor;

/**
 * La captura compartida, esperando a que la parte web venga a por ella.
 *
 * Hace falta un sitio donde dejarla porque quien la recibe (la Activity, al
 * llegar el intent) y quien la consume (el plugin, cuando el JavaScript ya ha
 * arrancado) no coinciden en el tiempo.
 */
final class CapturaPendiente {

    /** Tope de lo que se acepta. Una captura de movil no llega ni de lejos. */
    static final int MAXIMO_BYTES = 12 * 1024 * 1024;

    final String b64;
    final String tipo;

    private static CapturaPendiente actual = null;
    private static String fallo = null;

    private CapturaPendiente(String b64, String tipo) {
        this.b64 = b64;
        this.tipo = tipo;
    }

    static synchronized void guardar(String b64, String tipo) {
        actual = new CapturaPendiente(b64, tipo);
        fallo = null;
    }

    /** Deja constancia de que llego una captura pero no se pudo leer.
     *
     * Sin esto la aplicacion abria como si no hubiera pasado nada, que es la
     * peor respuesta posible: el usuario ha compartido algo y no ve ni el
     * resultado ni el motivo.
     */
    static synchronized void anotarFallo(String motivo) {
        fallo = motivo;
    }

    static synchronized String tomarFallo() {
        String motivo = fallo;
        fallo = null;
        return motivo;
    }

    /** Devuelve la captura y la borra: se entrega una sola vez. */
    static synchronized CapturaPendiente tomar() {
        CapturaPendiente pendiente = actual;
        actual = null;
        return pendiente;
    }
}

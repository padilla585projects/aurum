package com.aurum.advisor;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Recoge la captura que el usuario ha compartido con AURUM desde otra
 * aplicacion.
 *
 * Existe porque integrar un navegador dentro de la app para capturar el broker
 * solo se puede hacer de forma insegura: Chrome Custom Tabs no deja mirar
 * dentro —y esa proteccion es justo lo que hace seguro meter ahi un banco— y un
 * WebView propio significaria que el acceso al broker ocurre en una vista que
 * controla esta aplicacion. Asi que el navegador se queda donde esta y solo
 * viaja la captura, cuando el usuario decide compartirla.
 */
@CapacitorPlugin(name = "CapturaCompartida")
public class CapturaCompartida extends Plugin {

    /**
     * Devuelve la captura pendiente, si la hay, y la consume.
     *
     * Se consume a proposito: si se quedara guardada, volver a abrir la
     * aplicacion reabriria el importador con una imagen vieja.
     */
    @PluginMethod
    public void recoger(PluginCall call) {
        JSObject respuesta = new JSObject();
        CapturaPendiente pendiente = CapturaPendiente.tomar();

        if (pendiente == null) {
            respuesta.put("hay", false);
            String fallo = CapturaPendiente.tomarFallo();
            if (fallo != null) respuesta.put("fallo", fallo);
        } else {
            respuesta.put("hay", true);
            respuesta.put("b64", pendiente.b64);
            respuesta.put("tipo", pendiente.tipo);
        }
        call.resolve(respuesta);
    }
}

package com.aurum.advisor;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "AurumCompartir";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Antes de super.onCreate: despues el puente ya esta montado y no lo ve.
        registerPlugin(CapturaCompartida.class);
        registerPlugin(Instalador.class);
        super.onCreate(savedInstanceState);
        leerCompartido(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (leerCompartido(intent) && getBridge() != null) {
            // Con la aplicacion ya abierta nadie va a volver a preguntar por su
            // cuenta, asi que hay que avisar de que ha llegado algo.
            getBridge().triggerWindowJSEvent("aurumCapturaCompartida");
        }
    }

    /** Guarda la imagen compartida, si el intent traia una. */
    private boolean leerCompartido(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return false;

        String tipo = intent.getType();
        if (tipo == null || !tipo.startsWith("image/")) return false;

        // La forma sin tipo quedo obsoleta en Android 13; la nueva no existe
        // antes, asi que hacen falta las dos.
        Uri origen = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU
            ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
            : intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (origen == null) return false;

        try (InputStream entrada = getContentResolver().openInputStream(origen)) {
            if (entrada == null) return false;

            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] trozo = new byte[16 * 1024];
            int leidos;
            while ((leidos = entrada.read(trozo)) != -1) {
                buffer.write(trozo, 0, leidos);
                if (buffer.size() > CapturaPendiente.MAXIMO_BYTES) {
                    Log.w(TAG, "Imagen demasiado grande, se descarta.");
                    return false;
                }
            }

            CapturaPendiente.guardar(
                Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP), tipo);
            return true;
        } catch (SecurityException e) {
            Log.w(TAG, "Android no ha dejado leer la imagen compartida", e);
            CapturaPendiente.anotarFallo(
                "Android no ha dado permiso para leer esa imagen. Prueba a compartirla "
                + "desde la galeria, o guardala y subela desde el importador.");
            return true;
        } catch (Exception e) {
            Log.w(TAG, "No se ha podido leer la imagen compartida", e);
            CapturaPendiente.anotarFallo("No se ha podido leer la imagen compartida.");
            return true;
        }
    }
}

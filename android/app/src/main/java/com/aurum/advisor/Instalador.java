package com.aurum.advisor;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Descarga la actualizacion y se la entrega al instalador de Android.
 *
 * Antes esto pasaba por abrir Chrome, descargar a mano y buscar el fichero en
 * las notificaciones. La confirmacion final la sigue pidiendo el sistema —eso
 * no se salta, y esta bien que sea asi— pero el paseo sobra.
 *
 * La direccion trae su propio vale firmado, asi que aqui no hace falta ninguna
 * sesion ni credencial: se descarga y punto.
 */
@CapacitorPlugin(name = "Instalador")
public class Instalador extends Plugin {

    private static final String TAG = "AurumInstalador";
    private static final String FICHERO = "aurum-actualizacion.apk";
    private static final int MAXIMO_BYTES = 80 * 1024 * 1024;

    @PluginMethod
    public void instalar(PluginCall call) {
        String direccion = call.getString("url");
        if (direccion == null || direccion.isEmpty()) {
            call.reject("Falta la direccion de la actualizacion.");
            return;
        }

        // Desde Android 8 hay que tener permiso para instalar fuera de la
        // tienda. Si no lo hay, se lleva al usuario a darlo en vez de fallar
        // con un mensaje que no dice que hacer.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !getContext().getPackageManager().canRequestPackageInstalls()) {
            abrirAjustesDePermiso();
            call.reject("Hace falta permitir que AURUM instale aplicaciones. Te he abierto los ajustes.");
            return;
        }

        // En un hilo aparte: son varios megas y bloquear la interfaz haria
        // pensar que la aplicacion se ha colgado.
        new Thread(() -> {
            try {
                File apk = descargar(direccion);
                lanzarInstalador(apk);
                JSObject r = new JSObject();
                r.put("lanzado", true);
                call.resolve(r);
            } catch (Exception e) {
                Log.w(TAG, "No se ha podido instalar la actualizacion", e);
                call.reject("No se ha podido descargar la actualizacion.");
            }
        }).start();
    }

    private File descargar(String direccion) throws Exception {
        File destino = new File(getContext().getCacheDir(), FICHERO);

        HttpURLConnection conexion = (HttpURLConnection) new URL(direccion).openConnection();
        conexion.setConnectTimeout(20000);
        conexion.setReadTimeout(60000);
        conexion.setInstanceFollowRedirects(true);

        try (InputStream entrada = conexion.getInputStream();
             FileOutputStream salida = new FileOutputStream(destino)) {

            if (conexion.getResponseCode() != HttpURLConnection.HTTP_OK) {
                throw new Exception("El servidor ha respondido " + conexion.getResponseCode());
            }

            byte[] trozo = new byte[32 * 1024];
            long total = 0;
            int leidos;
            while ((leidos = entrada.read(trozo)) != -1) {
                total += leidos;
                if (total > MAXIMO_BYTES) throw new Exception("La descarga es sospechosamente grande.");
                salida.write(trozo, 0, leidos);
            }
        } finally {
            conexion.disconnect();
        }
        return destino;
    }

    private void lanzarInstalador(File apk) {
        Uri uri = FileProvider.getUriForFile(
            getContext(), getContext().getPackageName() + ".fileprovider", apk);

        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);

        Activity actividad = getActivity();
        if (actividad != null) actividad.startActivity(intent);
        else getContext().startActivity(intent);
    }

    private void abrirAjustesDePermiso() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        Intent ajustes = new Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + getContext().getPackageName()));
        ajustes.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(ajustes);
    }
}

@echo off
setlocal enabledelayedexpansion

echo.
echo =======================================
echo   AURUM -- Build + Drive Upload
echo =======================================
echo.

:: ── 0. Bump version ───────────────────────────────────────────
echo [0/4] Actualizando version...
node bump.cjs %1
if errorlevel 1 ( echo ERROR en bump.cjs & exit /b 1 )

:: ── 1. Web build ──────────────────────────────────────────────
echo [1/4] Compilando web app...
call npm run build
if errorlevel 1 ( echo ERROR en npm build & exit /b 1 )
echo    OK

:: ── 2. Capacitor sync ─────────────────────────────────────────
echo [2/4] Sincronizando assets Android...
call npx cap sync android
if errorlevel 1 ( echo ERROR en cap sync & exit /b 1 )
echo    OK

:: ── 3. Gradle APK ─────────────────────────────────────────────
echo [3/4] Compilando APK...
cd android
call gradlew.bat assembleDebug --no-daemon -q
if errorlevel 1 ( echo ERROR en Gradle & cd .. & exit /b 1 )
cd ..
echo    OK

:: ── Buscar el APK generado ────────────────────────────────────
set APK=
for %%f in ("android\app\build\outputs\apk\debug\aurum-v*-debug.apk") do set APK=%%f
if "!APK!"=="" ( echo ERROR: APK no encontrado & exit /b 1 )
echo    APK: !APK!

:: ── 4. Subir a Google Drive ───────────────────────────────────
echo [4/4] Subiendo a Google Drive...
C:\rclone\rclone.exe copy "!APK!" "gdrive:" --drive-root-folder-id 1mS8rZP1h0RK-kStrRqwIT4v9fudbANc7
if errorlevel 1 ( echo ERROR subiendo a Drive & exit /b 1 )
echo    OK

:: ── Instalar en movil si esta conectado ───────────────────────
"%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" devices 2>nul | findstr /v "List" | findstr "device" >nul
if not errorlevel 1 (
  echo [+] Movil detectado -- instalando via ADB...
  "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" install -r "!APK!"
)

echo.
echo Listo^^! APK subido a Drive:
echo https://drive.google.com/drive/folders/1mS8rZP1h0RK-kStrRqwIT4v9fudbANc7
echo.

# ═══════════════════════════════════════════════════════════════
#  AURUM — instalador del backend privado (Windows)
#
#  Deja el backend funcionando y te da las dos cosas que hay que pegar
#  en Ajustes: la direccion y tu token.
#
#  Uso:  powershell -ExecutionPolicy Bypass -File instalar.ps1
# ═══════════════════════════════════════════════════════════════

# El correo se puede pasar por parametro para poder ejecutarlo sin intervencion
# (instalaciones desatendidas, pruebas). Si no se pasa, se pregunta.
param([string]$Correo = '')

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Paso($n, $texto) { Write-Host ""; Write-Host "[$n] $texto" -ForegroundColor Cyan }
function Bien($texto)     { Write-Host "    OK  $texto" -ForegroundColor Green }
function Aviso($texto)    { Write-Host "    !   $texto" -ForegroundColor Yellow }
function Muere($texto)    { Write-Host ""; Write-Host "    X   $texto" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  AURUM - backend privado" -ForegroundColor White
Write-Host "  ------------------------"

# ── 1. Python ──────────────────────────────────────────────────
Paso 1 "Comprobando Python"
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { Muere "No hay Python. Instalalo desde https://python.org y vuelve a ejecutar esto." }

$version = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ([version]$version -lt [version]"3.10") { Muere "Python $version es demasiado antiguo. Hace falta 3.10 o superior." }
Bien "Python $version"

# ── 2. Entorno aislado ─────────────────────────────────────────
# Se usa un entorno propio para no mezclar estas dependencias con las
# del resto del sistema, que es de donde salen la mitad de los problemas.
Paso 2 "Preparando el entorno"
if (-not (Test-Path ".venv")) { & python -m venv .venv }
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { Muere "No se ha podido crear el entorno virtual." }
Bien "Entorno listo"

Paso 3 "Instalando dependencias (puede tardar un par de minutos)"
& $py -m pip install --quiet --upgrade pip
& $py -m pip install --quiet -r requirements.txt
if ($LASTEXITCODE -ne 0) { Muere "Fallo instalando dependencias." }
Bien "Dependencias instaladas"

# ── 4. Configuracion ───────────────────────────────────────────
Paso 4 "Configuracion"
if (Test-Path ".env") {
    Bien "Ya existe un .env, se conserva"
} else {
    $claveArranque = & $py -c "import secrets; print(secrets.token_hex(32))"
    $claveCifrado  = & $py -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
    $correo = $Correo
    if (-not $correo) { $correo = Read-Host "    Tu correo (el mismo con el que entras en AURUM)" }
    if (-not $correo) { Muere "Hace falta un correo. Pasalo con -Correo tu@correo.com" }

    @"
# Generado por instalar.ps1. No compartas este fichero: contiene tus claves.

# Solo sirve para emitir el primer token. Despues deja de funcionar.
AURUM_API_KEY=$claveArranque

# Cifra tus credenciales de broker. Si la pierdes, habra que volver a
# introducirlas: no hay forma de recuperar lo ya cifrado.
AURUM_SECRET_KEY=$claveCifrado

AURUM_OWNER_EMAIL=$correo
AURUM_DB_PATH=./aurum.db
AURUM_ALLOWED_ORIGINS=https://aurum-7cm.pages.dev,capacitor://localhost

# Desactivado a proposito: AURUM puede leer tu cartera y proponer, pero no
# mandara ninguna orden al broker mientras esto sea false.
AURUM_TRADING_ENABLED=false
AURUM_MAX_DAILY_EUR=1000

# Credenciales de Trade Republic. Puedes dejarlas vacias y ponerlas despues
# desde la propia aplicacion.
TR_PHONE=
TR_PIN=

# Opcionales.
ANTHROPIC_API_KEY=
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
"@ | Set-Content -Path ".env" -Encoding utf8
    Bien "Configuracion creada en backend\.env"
}

# ── 5. Arranque ────────────────────────────────────────────────
Paso 5 "Arrancando el backend"
$yaVivo = $false
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8000/health" -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $yaVivo = $true }
} catch { }

if ($yaVivo) {
    Bien "Ya estaba en marcha"
} else {
    Start-Process -FilePath $py -ArgumentList "main.py" -WorkingDirectory $PSScriptRoot -WindowStyle Minimized
    $listo = $false
    foreach ($i in 1..20) {
        Start-Sleep -Seconds 2
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:8000/health" -TimeoutSec 3 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $listo = $true; break }
        } catch { }
    }
    if (-not $listo) { Muere "El backend no ha respondido. Mira la ventana que se ha abierto para ver el error." }
    Bien "Backend en marcha"
}

# ── 6. Tu token ────────────────────────────────────────────────
Paso 6 "Creando tu token de acceso"
$env_ = Get-Content ".env" | Where-Object { $_ -match '^AURUM_API_KEY=' }
$claveArranque = ($env_ -split '=', 2)[1]
$correo = (Get-Content ".env" | Where-Object { $_ -match '^AURUM_OWNER_EMAIL=' } | ForEach-Object { ($_ -split '=', 2)[1] })

$cuerpo = @{ user_email = $correo; role = "owner"; scopes = @("read","execute","admin") } | ConvertTo-Json
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8000/admin/tokens" -Method Post `
        -Headers @{ "X-AURUM-KEY" = $claveArranque; "Content-Type" = "application/json" } -Body $cuerpo
    $token = $resp.token
    Bien "Token creado"
} catch {
    Aviso "No se ha creado: probablemente ya existia uno de antes."
    Aviso "Si lo has perdido, borra backend\aurum.db y vuelve a ejecutar esto."
    $token = $null
}

# ── Resultado ──────────────────────────────────────────────────
Write-Host ""
Write-Host "  ================================================" -ForegroundColor White
Write-Host "   Listo. Abre AURUM y ve a Ajustes -> Backend" -ForegroundColor White
Write-Host "  ================================================" -ForegroundColor White
Write-Host ""
Write-Host "   Direccion:  http://localhost:8000" -ForegroundColor Cyan
if ($token) {
    Write-Host "   Token:      $token" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "   Copialo ahora: no se puede volver a mostrar." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "   Esa direccion funciona si usas AURUM en ESTE ordenador."
Write-Host "   Para entrar desde el movil, mira docs/BACKEND.md."
Write-Host ""

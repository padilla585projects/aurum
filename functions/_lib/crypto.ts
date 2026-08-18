/**
 * Primitivas criptográficas para el edge (WebCrypto, sin dependencias).
 *
 * Reglas que sigue todo este módulo:
 *   · Ningún secreto se guarda en claro: contraseñas con PBKDF2, tokens con SHA-256.
 *   · Toda comparación de secretos es en tiempo constante.
 *   · El formato del hash incluye sus parámetros, para poder subir el coste sin
 *     invalidar las contraseñas ya registradas (ver needsRehash).
 */

const enc = new TextEncoder();

/**
 * Coste de PBKDF2. OWASP recomienda 600.000 para PBKDF2-HMAC-SHA256, pero las
 * Pages Functions del plan gratuito tienen un presupuesto de CPU muy ajustado y
 * ese valor agota el límite en cada login. 100.000 es el compromiso habitual en
 * Workers. Si se migra a plan de pago, subir esta constante: los hashes
 * antiguos se re-generan solos en el siguiente login correcto.
 */
export const PBKDF2_ITERATIONS = 100_000;
const KEY_LEN_BITS = 256;

/* ── Codificación ────────────────────────────────────────────── */

export function toBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array<ArrayBuffer>): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Aleatoriedad ────────────────────────────────────────────── */

/** Token opaco de alta entropía (32 bytes por defecto) en base64url. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Identificador aleatorio para filas (uuid v4). */
export function randomId(): string {
  return crypto.randomUUID();
}

/**
 * Código de invitación legible: 4 grupos de 5 caracteres sin vocales ni
 * caracteres ambiguos (0/O, 1/I/L), para poder dictarlo sin errores.
 */
export function randomInviteCode(): string {
  const alphabet = '23456789BCDFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = Array.from(bytes, b => alphabet[b % alphabet.length]);
  return [0, 5, 10, 15].map(i => chars.slice(i, i + 5).join('')).join('-');
}

/* ── Comparación en tiempo constante ─────────────────────────── */

export function timingSafeEqual(a: string, b: string): boolean {
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  // La longitud sí se filtra, pero no el contenido. Para hashes de longitud
  // fija (el caso de todo este módulo) eso no revela nada.
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/* ── Hash de tokens (sesiones, invitaciones) ─────────────────── */

/**
 * SHA-256 en hex. Se usa para guardar tokens de sesión e invitaciones: si
 * alguien lee la base de datos no obtiene credenciales utilizables.
 * No lleva sal a propósito — la entrada ya son 256 bits aleatorios.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return toHex(new Uint8Array(digest));
}

/* ── Contraseñas ─────────────────────────────────────────────── */

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_LEN_BITS,
  );
  return new Uint8Array(bits);
}

/** Devuelve "pbkdf2$sha256$<iteraciones>$<sal>$<hash>", todo en base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Cuenta solo-OAuth. Gastamos el mismo tiempo que una verificación real
    // para no revelar por latencia qué cuentas tienen contraseña.
    await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS);
    return false;
  }
  const [scheme, hashName, iterStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2' || hashName !== 'sha256') return false;
  const iterations = Number(iterStr);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const computed = await pbkdf2(password, fromBase64Url(saltB64), iterations);
  return timingSafeEqual(toBase64Url(computed), hashB64);
}

/** true si el hash se generó con un coste inferior al actual. */
export function needsRehash(stored: string | null): boolean {
  if (!stored) return false;
  const iterations = Number(stored.split('$')[2]);
  return !Number.isFinite(iterations) || iterations < PBKDF2_ITERATIONS;
}

/* ── HMAC (state de OAuth y otros valores firmados) ──────────── */

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return toBase64Url(new Uint8Array(sig));
}

export async function hmacVerify(secret: string, data: string, signature: string): Promise<boolean> {
  return timingSafeEqual(await hmacSign(secret, data), signature);
}

/** Payload firmado y con caducidad: "<datosB64>.<expiración>.<firma>". */
export async function signPayload(secret: string, payload: unknown, ttlMs: number): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify(payload)));
  const exp = Date.now() + ttlMs;
  return `${body}.${exp}.${await hmacSign(secret, `${body}.${exp}`)}`;
}

export async function verifyPayload<T>(secret: string, token: string): Promise<T | null> {
  const [body, expStr, sig] = token.split('.');
  if (!body || !expStr || !sig) return null;
  if (!(await hmacVerify(secret, `${body}.${expStr}`, sig))) return null;
  if (Date.now() > Number(expStr)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T;
  } catch {
    return null;
  }
}

/* ── PKCE (Google OAuth) ─────────────────────────────────────── */

export function pkceVerifier(): string {
  return randomToken(32);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

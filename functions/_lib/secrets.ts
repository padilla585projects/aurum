/**
 * Cifrado en reposo de las claves de proveedor que aporta cada usuario.
 *
 * La clave maestra se deriva de AURUM_SIGNING_SECRET con HKDF, usando una
 * etiqueta propia. Así no hace falta configurar otro secreto, y la clave de
 * cifrado no es la misma que la de firma: comprometer una no entrega la otra.
 *
 * El criptograma se autentica con el par (usuario, proveedor). Mover una fila
 * de un usuario a otro en la base de datos no sirve de nada: el descifrado
 * falla porque el dato asociado ya no coincide.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const HKDF_INFO = 'aurum:claves-de-proveedor:v1';

async function aesKey(signingSecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(signingSecret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(HKDF_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Cifra y devuelve base64 de nonce||criptograma. */
export async function encryptSecret(signingSecret: string, plaintext: string, associated: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const blob = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(associated) },
    await aesKey(signingSecret),
    enc.encode(plaintext),
  );
  const raw = new Uint8Array(nonce.length + blob.byteLength);
  raw.set(nonce, 0);
  raw.set(new Uint8Array(blob), nonce.length);
  return toBase64(raw);
}

/** Descifra. Devuelve null si el dato está corrupto o no corresponde al dueño. */
export async function decryptSecret(signingSecret: string, payload: string, associated: string): Promise<string | null> {
  try {
    const raw = fromBase64(payload);
    const nonce = raw.slice(0, 12);
    const blob = raw.slice(12);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(associated) },
      await aesKey(signingSecret),
      blob,
    );
    return dec.decode(plain);
  } catch {
    return null;
  }
}

/**
 * Pista que sí puede volver al cliente: los últimos cuatro caracteres. Sirve
 * para reconocer la clave puesta sin revelarla, y con menos de ocho caracteres
 * no se enseña nada.
 */
export function keyHint(key: string): string {
  return key.length < 8 ? '••••' : `••••${key.slice(-4)}`;
}

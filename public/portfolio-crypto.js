/**
 * Client-side portfolio PIN crypto. The server never sees the PIN or a key.
 * AES-GCM ciphertext is what gets stored. There is no recovery key.
 */

export const KDF_ITERATIONS = 210_000;

export function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function createKdf() {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { v: 1, salt: bytesToBase64(salt), iterations: KDF_ITERATIONS, hash: "SHA-256" };
}

export async function derivePortfolioKey(pin, kdf) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pin)), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: base64ToBytes(kdf.salt),
      iterations: kdf.iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptQuantity(key, quantity) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ q: quantity }));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(cipher)) };
}

export async function decryptQuantity(key, payload) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.ct),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  if (!parsed || typeof parsed.q !== "number" || !Number.isFinite(parsed.q)) {
    throw new Error("decrypted quantity is unreadable");
  }
  return parsed.q;
}

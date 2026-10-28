/** HMAC helpers: signed job tokens and constant-time comparison. */

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await importKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function hmacBase64Url(secret: string, message: string): Promise<string> {
  const key = await importKey(secret);
  return toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Constant-time string comparison (length is not secret here). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  // Compare against the longer buffer so the loop length does not depend on a match.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Token the container presents when calling back into the Worker for a specific job. */
export async function signJobToken(secret: string, jobId: string): Promise<string> {
  return hmacBase64Url(secret, `job:${jobId}`);
}

export async function verifyJobToken(secret: string, jobId: string, token: string): Promise<boolean> {
  return timingSafeEqual(await signJobToken(secret, jobId), token);
}

/** Expiring download token: `<expiresEpochSeconds>.<signature>`. */
export async function signDownloadToken(secret: string, objectKey: string, expiresAtSeconds: number): Promise<string> {
  const sig = await hmacBase64Url(secret, `dl:${objectKey}:${expiresAtSeconds}`);
  return `${expiresAtSeconds}.${sig}`;
}

export async function verifyDownloadToken(
  secret: string,
  objectKey: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expires = Number(token.slice(0, dot));
  if (!Number.isFinite(expires) || expires < nowSeconds) return false;
  return timingSafeEqual(await signDownloadToken(secret, objectKey, expires), token);
}

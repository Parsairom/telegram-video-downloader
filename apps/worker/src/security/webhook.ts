import { timingSafeEqual } from "./hmac";

/** Telegram echoes the `secret_token` given to setWebhook in this header on every update. */
export const WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

export function verifyWebhookSecret(request: Request, secret: string | undefined): boolean {
  if (!secret) return false; // never accept updates when the secret is not configured
  const supplied = request.headers.get(WEBHOOK_SECRET_HEADER);
  return supplied !== null && timingSafeEqual(supplied, secret);
}

/** Telegram allows A-Z a-z 0-9 _ - and 1–256 characters. */
export function isValidWebhookSecret(secret: string): boolean {
  return /^[A-Za-z0-9_-]{16,256}$/.test(secret);
}

/**
 * Secrets and optional settings that are NOT in wrangler.jsonc (set with `wrangler secret put`, see
 * scripts/set-secrets.mjs). `wrangler types` only knows about bindings and `vars`, so they are declared here
 * and merged into both the global `Env` and `Cloudflare.Env` interfaces.
 */
interface SecretBindings {
  /** Telegram bot token from @BotFather. */
  BOT_TOKEN: string;
  /** Value Telegram echoes in X-Telegram-Bot-Api-Secret-Token on every webhook call. */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** HMAC key for per-job container tokens and signed download links. Never sent to a container. */
  INTERNAL_SIGNING_SECRET: string;
  /** Shared secret the Worker presents to the media containers. */
  CONTAINER_API_KEY: string;
  /** Comma-separated Telegram user IDs of administrators. */
  ADMIN_USER_IDS?: string;
  /** Public https URL of this Worker (container callbacks and download links use it). */
  PUBLIC_BASE_URL?: string;
  /** Optional: enables the local Bot API server inside job containers (see docs/large-file-delivery.md). */
  TELEGRAM_API_ID?: string;
  TELEGRAM_API_HASH?: string;
  /** Optional separate bot used for local-server delivery. */
  LOCAL_BOT_TOKEN?: string;
}

/* eslint-disable @typescript-eslint/no-empty-object-type -- declaration merging needs empty extending interfaces */
interface Env extends SecretBindings {}

declare namespace Cloudflare {
  interface Env extends SecretBindings {}
}

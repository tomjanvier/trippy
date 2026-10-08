import type { D1Database, DurableObjectNamespace, Fetcher, KVNamespace, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  PHOTOS_BUCKET: R2Bucket;
  SESSIONS: KVNamespace;
  TRIP_ROOM: DurableObjectNamespace;
  /** Workers Static Assets (front ./public, fallback SPA). */
  ASSETS: Fetcher;
  JWT_SECRET: string;
  APP_URL?: string;
  WP_SITE_URL?: string;
  WP_USERNAME?: string;
  WP_APP_PASSWORD?: string;
  INSTAGRAM_ACCESS_TOKEN?: string;
  MAP_DEFAULT_STYLE?: string;
}

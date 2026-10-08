import type { R2Bucket } from "@cloudflare/workers-types";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_PREFIXES = ["image/", "video/"];

export function assertUploadable(contentType: string, size: number | null): void {
  if (!ALLOWED_PREFIXES.some((p) => contentType.startsWith(p))) {
    throw new Error("unsupported_media_type");
  }
  if (size !== null && size > MAX_UPLOAD_BYTES) throw new Error("file_too_large");
}

export function photoKey(tripId: number, ext: string): string {
  const id = crypto.randomUUID();
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
  return `photos/${tripId}/${id}.${safeExt}`;
}

export async function putPhoto(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream | ArrayBuffer,
  contentType: string,
): Promise<void> {
  await bucket.put(key, body as never, { httpMetadata: { contentType } });
}

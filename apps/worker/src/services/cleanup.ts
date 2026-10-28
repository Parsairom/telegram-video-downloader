/** Expiry of R2 objects (download links, thumbnails), abandoned multipart uploads and old history. */
import type { Deps } from "../app";
import { purgeOldJobs } from "../db/jobs";
import { listAbandonedUploads, listExpiredR2Objects, markR2Deleted, purgeBookkeeping } from "../db/misc";

export interface CleanupReport {
  expiredObjectsDeleted: number;
  abandonedUploadsAborted: number;
  historyPurged: number;
}

const ABANDONED_AFTER_SECONDS = 6 * 3600;

export async function cleanupStorage(deps: Deps): Promise<Pick<CleanupReport, "expiredObjectsDeleted" | "abandonedUploadsAborted">> {
  const bucket = deps.bucket;
  if (!bucket) return { expiredObjectsDeleted: 0, abandonedUploadsAborted: 0 }; // free plan without R2: nothing is ever stored
  const now = deps.now();
  let expiredObjectsDeleted = 0;
  let abandonedUploadsAborted = 0;

  for (const row of await listExpiredR2Objects(deps.db, now)) {
    try {
      if (row.upload_id) await bucket.resumeMultipartUpload(row.object_key, row.upload_id).abort().catch(() => undefined);
      await bucket.delete(row.object_key);
      await markR2Deleted(deps.db, row.object_key, now);
      expiredObjectsDeleted++;
    } catch (error) {
      deps.log.warn("could not delete expired object", { key: row.object_key, error });
    }
  }
  for (const row of await listAbandonedUploads(deps.db, now - ABANDONED_AFTER_SECONDS)) {
    try {
      if (row.upload_id) await bucket.resumeMultipartUpload(row.object_key, row.upload_id).abort().catch(() => undefined);
      await markR2Deleted(deps.db, row.object_key, now);
      abandonedUploadsAborted++;
    } catch (error) {
      deps.log.warn("could not abort abandoned upload", { key: row.object_key, error });
    }
  }
  return { expiredObjectsDeleted, abandonedUploadsAborted };
}

export async function purgeHistory(deps: Deps): Promise<number> {
  const now = deps.now();
  const removed = await purgeOldJobs(deps.db, now - deps.cfg.historyRetentionDays * 86400);
  await purgeBookkeeping(deps.db, now);
  return removed;
}

export async function runCleanup(deps: Deps): Promise<CleanupReport> {
  const storage = await cleanupStorage(deps);
  const historyPurged = await purgeHistory(deps);
  return { ...storage, historyPurged };
}

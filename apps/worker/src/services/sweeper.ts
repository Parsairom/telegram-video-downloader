/**
 * Per-minute reconciliation (cron trigger). This is what makes jobs recoverable:
 *  - polls every running job's container (also counts as activity, so the container stays awake),
 *  - applies results whose callbacks were lost, restarts jobs whose container was lost,
 *  - re-queues overdue retries and queue messages that vanished,
 *  - expires stale menus, deletes expired R2 objects, purges old history, advances announcements.
 */
import type { Deps } from "../app";
import { removeMenuKeyboard } from "./menu";
import { jobSelection, listRetryDue, listRunningJobs, listStale, touchJob, transition } from "../db/jobs";
import { cleanupStorage, purgeHistory } from "./cleanup";
import { failOrRetry, reconcileContainerStatus } from "./jobs";
import { refreshStatus } from "./progress";
import { broadcastTick } from "./broadcast";

const HEARTBEAT_GRACE_SECONDS = 180; // container silent AND unreachable for this long => lost
const STALE_QUEUED_SECONDS = 600;
const STALE_INSPECTING_SECONDS = 300;
const READY_TTL_SECONDS = 3600;
const RETRY_OVERDUE_SECONDS = 300;

export interface SweepReport {
  polled: number;
  recovered: number;
  requeued: number;
  expired: number;
}

export async function runSweeper(deps: Deps): Promise<SweepReport> {
  const report: SweepReport = { polled: 0, recovered: 0, requeued: 0, expired: 0 };
  const now = deps.now();

  // 1) running jobs ↔ containers
  for (const job of await listRunningJobs(deps.db)) {
    report.polled++;
    try {
      const status = await deps.backend.jobStatus(job.id);
      const silentFor = now - (job.last_heartbeat_at ?? job.updated_at);
      if (status === null) {
        if (silentFor > HEARTBEAT_GRACE_SECONDS) {
          deps.log.warn("container unreachable and silent, treating as lost", { jobId: job.id, silentFor });
          await failOrRetry(deps, job, "container_lost", "the media container stopped responding", true);
          report.recovered++;
        }
        continue;
      }
      if (status.state === "unknown") {
        // the container restarted and forgot the job (its disk is ephemeral): start over on a fresh instance
        await failOrRetry(deps, job, "container_lost", "the media container restarted", true);
        report.recovered++;
        continue;
      }
      await reconcileContainerStatus(deps, job, status);
      if (status.state === "completed" || status.state === "failed") report.recovered++;
      if (silentFor > HEARTBEAT_GRACE_SECONDS && status.state === "running") await deps.db.prepare("UPDATE jobs SET last_heartbeat_at = ? WHERE id = ?").bind(now, job.id).run();
    } catch (error) {
      deps.log.warn("sweeper could not reconcile job", { jobId: job.id, error });
    }
  }

  // 2) retries that should have been picked up by now (the delayed queue message may have been lost)
  for (const job of await listRetryDue(deps.db, now - RETRY_OVERDUE_SECONDS)) {
    await deps.queue.send(
      jobSelection(job)
        ? { type: "download", jobId: job.id, correlationId: job.correlation_id, attempt: job.attempts }
        : { type: "inspect", jobId: job.id, correlationId: job.correlation_id },
    );
    await touchJob(deps.db, job.id, now);
    report.requeued++;
  }

  // 3) jobs stuck in `queued` — the queue message is gone
  for (const job of await listStale(deps.db, "queued", now - STALE_QUEUED_SECONDS)) {
    await deps.queue.send(
      jobSelection(job)
        ? { type: "download", jobId: job.id, correlationId: job.correlation_id, attempt: job.attempts }
        : { type: "inspect", jobId: job.id, correlationId: job.correlation_id },
    );
    await touchJob(deps.db, job.id, now);
    report.requeued++;
  }

  // 4) inspections that never finished
  for (const job of await listStale(deps.db, "inspecting", now - STALE_INSPECTING_SECONDS)) {
    if (await transition(deps.db, job.id, "inspecting", "failed", now, { error_code: "timeout", error_message: "inspection did not finish" }, "stale")) {
      await refreshStatus(deps, job.id, { force: true });
      report.expired++;
    }
  }

  // 5) menus nobody answered
  for (const job of await listStale(deps.db, "ready", now - READY_TTL_SECONDS)) {
    if (await transition(deps.db, job.id, "ready", "expired", now, {}, "menu expired")) {
      await removeMenuKeyboard(deps, job);
      report.expired++;
    }
  }

  // 6) housekeeping
  await cleanupStorage(deps);
  if (new Date(now * 1000).getUTCMinutes() === 0) await purgeHistory(deps);
  await broadcastTick(deps);
  return report;
}

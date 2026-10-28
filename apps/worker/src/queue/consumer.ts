import type { QueueMessage } from "@tvd/shared-types";
import { z } from "zod";
import { createDeps, type Deps } from "../app";
import { runFramePreview } from "../callbacks/job-actions";
import { getJob } from "../db/jobs";
import { cleanupStorage } from "../services/cleanup";
import { failJob, runDownloadDispatch, runInspect, type StepResult } from "../services/jobs";

const MessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inspect"), jobId: z.string(), correlationId: z.string() }),
  z.object({ type: z.literal("download"), jobId: z.string(), correlationId: z.string(), attempt: z.number() }),
  z.object({ type: z.literal("frames"), jobId: z.string(), correlationId: z.string() }),
  z.object({ type: z.literal("cleanup"), jobId: z.string(), correlationId: z.string() }),
]);

/**
 * Queue handler. A message only *starts* work (it is acknowledged as soon as the container accepted the job);
 * long downloads run inside the container and report back through signed callbacks, so no message stays
 * un-acked for the duration of a download. Redelivery is harmless: every step is compare-and-set guarded.
 */
export async function handleQueue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
  const deps = await createDeps(env, ctx);
  const isDeadLetter = batch.queue.endsWith("-dlq");
  for (const message of batch.messages) {
    const parsed = MessageSchema.safeParse(message.body);
    if (!parsed.success) {
      deps.log.error("discarding malformed queue message", { id: message.id });
      message.ack();
      continue;
    }
    const body = parsed.data as QueueMessage;
    try {
      if (isDeadLetter) {
        await handleDeadLetter(deps, body);
        message.ack();
        continue;
      }
      const result = await processMessage(deps, body, message.attempts);
      if (result.done) message.ack();
      else message.retry({ delaySeconds: result.retryDelaySeconds ?? 30 });
    } catch (error) {
      deps.log.error("queue message failed", { type: body.type, jobId: "jobId" in body ? body.jobId : undefined, attempts: message.attempts, error });
      message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 600) });
    }
  }
}

export async function processMessage(deps: Deps, body: QueueMessage, deliveryAttempt: number): Promise<StepResult> {
  switch (body.type) {
    case "inspect":
      return runInspect(deps, body.jobId, deliveryAttempt);
    case "download":
      return runDownloadDispatch(deps, body.jobId);
    case "frames":
      await runFramePreview(deps, body.jobId);
      return { done: true };
    case "cleanup":
      await cleanupStorage(deps);
      return { done: true };
  }
}

/** A message that exhausted all retries: make sure the user is not left waiting forever. */
async function handleDeadLetter(deps: Deps, body: QueueMessage): Promise<void> {
  if (!("jobId" in body)) return;
  const job = await getJob(deps.db, body.jobId);
  if (!job) return;
  deps.log.error("job message reached the dead-letter queue", { jobId: job.id, type: body.type });
  await failJob(deps, job, "internal", "processing could not be started after several attempts", false);
}

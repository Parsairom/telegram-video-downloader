import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { countRunning, getJob, jobSelection } from "../src/db/jobs";
import { signJobToken, verifyJobToken } from "../src/security/hmac";
import type { Draft } from "../src/services/selection";
import { ADMIN, ALICE, BOB, containerEvent, directResult, latestJob, linkResult, pressQuality, reload, startDownload, submitAndInspect } from "./flow-helpers";
import { allButtons, buttonData, callback, makeHarness, sampleInfo, send, userMessage } from "./helpers";

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("intake", () => {
  it("/start greets in Persian and shows the main menu", async () => {
    const h = makeHarness();
    await send(h, userMessage(ALICE, "/start"));
    const call = h.tg.last("sendMessage")!;
    expect(call.params.text).toContain("سلام");
    expect(call.params.reply_markup.keyboard.flat().map((b: { text: string }) => b.text)).toEqual(["🎬 دانلود ویدیو", "⚙️ تنظیمات", "📂 تاریخچه دانلودها", "❓ راهنما", "👤 حساب کاربری"]);
  });

  it("a URL is accepted directly (no menu first), answered immediately, and only queued — nothing heavy runs inline", async () => {
    const h = makeHarness();
    await send(h, userMessage(ALICE, `please ${YT}`));
    expect(h.tg.texts().at(-1)).toContain("در حال بررسی لینک و استخراج اطلاعات ویدیو");
    const job = await latestJob(h, ALICE);
    expect(job).toMatchObject({ status: "queued", user_id: ALICE, source_url: YT });
    expect(h.queue.messages.map((m) => m.body.type)).toEqual(["inspect"]);
    expect(h.backend.inspectCalls).toHaveLength(0); // the webhook did not call the container
    expect(job.status_message_id).toBeTruthy();
  });

  it("rejects unsafe or invalid links without creating a job", async () => {
    const h = makeHarness();
    for (const bad of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "ftp://example.com/x", "file:///etc/passwd"]) {
      await send(h, userMessage(ALICE, bad));
    }
    const count = await h.deps.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?").bind(ALICE).first<{ n: number }>();
    expect(count!.n).toBe(0);
    expect(h.queue.messages).toHaveLength(0);
    const texts = h.tg.texts();
    expect(texts.filter((t) => t.includes("مجاز نیست"))).toHaveLength(2); // the two internal addresses are refused explicitly
    expect(texts.filter((t) => t.includes("متوجه نشدم"))).toHaveLength(2); // ftp:// and file:// are not links the bot extracts at all
  });

  it("does not start a second job for the same link while one is active", async () => {
    const h = makeHarness();
    await send(h, userMessage(ALICE, YT));
    await send(h, userMessage(ALICE, `${YT}&utm_source=share`)); // tracking params normalise to the same link
    expect(await h.deps.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?").bind(ALICE).first<{ n: number }>().then((r) => r!.n)).toBe(1);
    expect(h.tg.texts().at(-1)).toContain("در حال پردازشه");
  });

  it("enforces the per-user active-job limit and the per-minute rate limit", async () => {
    const h = makeHarness({ MAX_JOBS_PER_USER: "1" });
    await send(h, userMessage(ALICE, "https://a.example.com/v/1"));
    await send(h, userMessage(ALICE, "https://a.example.com/v/2"));
    expect(h.tg.texts().at(-1)).toContain("دانلود فعال داری");
    const fast = makeHarness({ MAX_JOBS_PER_USER: "10", RATE_LIMIT_PER_MINUTE: "2" });
    for (let i = 0; i < 4; i++) await send(fast, userMessage(BOB, `https://b.example.com/v/${i}`));
    expect(fast.tg.texts().filter((t) => t.includes("ثانیه‌ی دیگه")).length).toBeGreaterThanOrEqual(1);
    expect(await fast.deps.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?").bind(BOB).first<{ n: number }>().then((r) => r!.n)).toBe(2);
  });

  it("blocked users and maintenance mode are refused", async () => {
    const h = makeHarness();
    await h.deps.db.prepare("INSERT INTO users (tg_user_id, is_blocked, block_reason, created_at, last_seen_at) VALUES (?, 1, 'spam', 1, 1)").bind(555).run();
    await send(h, userMessage(555, YT));
    expect(h.tg.texts().at(-1)).toContain("مسدود");
    expect(h.queue.messages).toHaveLength(0);
    h.deps.cfg.maintenance = true;
    await send(h, userMessage(ALICE, YT));
    expect(h.tg.texts().at(-1)).toContain("نگه‌داری");
    await send(h, userMessage(ADMIN, "/start")); // administrators keep working during maintenance
    expect(h.tg.texts().at(-1)).toContain("سلام");
  });
});

describe("inspection → quality menu", () => {
  it("shows the real title, source, duration and only the qualities that exist, with sizes and delivery badges", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE, YT);
    expect(job.status).toBe("ready");
    const photo = h.tg.last("sendPhoto")!;
    expect(photo.params.photo).toBe("https://img.example.test/t.jpg");
    const caption = String(photo.params.caption);
    expect(caption).toContain("Big Buck Bunny");
    expect(caption).toContain("YouTube");
    expect(caption).toContain("10:00");
    expect(caption).toMatch(/2160p60 — ≈?2\.4 GB 🚫/); // above the 1.9 GB ceiling
    expect(caption).toMatch(/1080p60 — 310 MB 🔗/); // too big for a direct Telegram upload -> link
    expect(caption).toMatch(/144p — 15\.0 MB 📤/); // 5 MB video + 10 MB audio: fits Telegram directly
    expect(caption).not.toContain("1440p");
    const labels = allButtons(h).map((b) => b.text);
    expect(labels.some((l) => l.includes("1080p60"))).toBe(true);
    expect(labels.some((l) => l.includes("1440"))).toBe(false);
    expect(labels.some((l) => l.includes("MP3"))).toBe(true);
    expect(labels.some((l) => l.includes("فرمت‌های پیشرفته"))).toBe(true);
    for (const b of allButtons(h)) expect(new TextEncoder().encode(b.callback_data ?? "").length).toBeLessThanOrEqual(64);
    expect(job.status_message_id).toBeNull(); // the "checking..." message was replaced by the menu
    expect(h.tg.of("deleteMessage")).toHaveLength(1);
  });

  it("falls back to a text menu when Telegram rejects the cover photo", async () => {
    const h = makeHarness();
    h.tg.failNext("sendPhoto", 400, "Bad Request: wrong type of the web page content");
    const job = await submitAndInspect(h, ALICE, YT);
    expect(job.status).toBe("ready");
    expect(job.menu_is_photo).toBe(0);
    expect(h.tg.of("sendMessage").some((c) => String(c.params.text).includes("کیفیت‌های موجود"))).toBe(true);
  });

  it("reports a failed inspection in Persian with the real reason, never a stack trace", async () => {
    const h = makeHarness();
    h.backend.inspectOutcome = { ok: false, error: { code: "private_video", message: "Private video", retryable: false } };
    await send(h, userMessage(ALICE, YT));
    await h.runQueue();
    const job = await latestJob(h, ALICE);
    expect(job).toMatchObject({ status: "failed", error_code: "private_video" });
    expect(h.tg.texts().at(-1)).toContain("خصوصی");
  });

  it("retries a transient inspection failure with backoff, then succeeds", async () => {
    const h = makeHarness();
    let calls = 0;
    h.backend.inspectOutcome = () => (++calls === 1 ? { ok: false, error: { code: "network_error", message: "timeout", retryable: true } } : { ok: true, data: { kind: "video", info: sampleInfo() } });
    await send(h, userMessage(ALICE, YT));
    expect(await h.runQueue()).toBe(1);
    expect((await latestJob(h, ALICE)).status).toBe("retry_wait");
    expect(h.queue.messages).toHaveLength(1); // re-queued (the consumer returned a delay)
    expect(await h.runQueue()).toBe(0); // not due yet
    h.advance(11);
    await h.runQueue();
    expect((await latestJob(h, ALICE)).status).toBe("ready");
  });

  it("a redelivered inspect message does not inspect twice", async () => {
    const h = makeHarness();
    await send(h, userMessage(ALICE, YT));
    const message = h.queue.messages[0]!;
    h.queue.messages.push(message); // simulate at-least-once redelivery
    await h.runQueue();
    expect(h.backend.inspectCalls).toHaveLength(1);
    expect(h.tg.of("sendPhoto")).toHaveLength(1);
  });

  it("offers a picker for multi-video links and re-submits the chosen entry", async () => {
    const h = makeHarness();
    h.backend.inspectOutcome = { ok: true, data: { kind: "playlist", title: "My list", total: 2, entries: [
      { index: 1, title: "First", url: "https://example.com/v/1", durationSeconds: 10 },
      { index: 2, title: "Second", url: "https://example.com/v/2", durationSeconds: 20 },
    ] } };
    await send(h, userMessage(ALICE, "https://example.com/list"));
    await h.runQueue();
    expect(h.tg.texts().at(-1)).toContain("این لینک ۲ ویدیو داره");
    h.backend.inspectOutcome = { ok: true, data: { kind: "video", info: sampleInfo({ title: "Second" }) } };
    await send(h, callback(ALICE, buttonData(h, "2. Second")));
    await h.runQueue();
    const latest = await latestJob(h, ALICE);
    expect(latest.source_url).toBe("https://example.com/v/2");
    expect(latest.status).toBe("ready");
  });
});

describe("selecting a quality starts a verified job", () => {
  it("builds the container request from exactly the chosen format ids and signs the callback token", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE, YT);
    await pressQuality(h, ALICE, job, "1080p60");
    let row = await reload(h, job);
    expect(row.status).toBe("queued");
    expect(h.tg.of("editMessageReplyMarkup")).toHaveLength(1); // the menu can no longer be pressed twice
    expect(h.queue.messages.map((m) => m.body.type)).toEqual(["download"]);
    await h.runQueue();
    row = await reload(h, job);
    expect(row).toMatchObject({ status: "downloading", attempts: 1 });
    expect(h.backend.started).toHaveLength(1);
    const req = h.backend.started[0]!;
    expect(req).toMatchObject({
      jobId: job.id, url: YT, chatId: ALICE,
      selection: { kind: "video", videoFormatId: "299", audioFormatId: "140", container: "mp4", deliveryMode: "r2_link", estimatedBytes: 310_000_000, expectedHeight: 1080, allowTranscode: false, thumbnail: { mode: "original" } },
      limits: { maxOutputBytes: 1_900_000_000, downloadTimeoutSeconds: 3600 },
      callback: { baseUrl: "https://tvd.example.test" },
    });
    expect(req.selection).not.toHaveProperty("optionKey");
    expect(await verifyJobToken(env.INTERNAL_SIGNING_SECRET, job.id, req.callback.token)).toBe(true);
    expect(JSON.stringify(req)).not.toContain(env.INTERNAL_SIGNING_SECRET);
    expect(req.meta).toMatchObject({ title: "Big Buck Bunny", site: "YouTube", uploader: "Blender", durationSeconds: 600 });
    expect(h.tg.texts().some((t) => t.includes("در حال آماده‌سازی سرور پردازش"))).toBe(true);
  });

  it("refuses an over-limit quality with an alert and does not start anything", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE, YT);
    await pressQuality(h, ALICE, job, "2160p60");
    const answer = h.tg.last("answerCallbackQuery")!;
    expect(answer.params.show_alert).toBe(true);
    expect(String(answer.params.text)).toContain("قابل ارسال نیست");
    expect((await reload(h, job)).status).toBe("ready");
    expect(h.queue.messages).toHaveLength(0);
  });

  it("a small file is delivered straight to Telegram with a link fallback only for the automatic policy", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE, YT);
    await pressQuality(h, ALICE, job, "144p");
    await h.runQueue();
    const req = h.backend.started[0]!;
    expect(req.selection).toMatchObject({ deliveryMode: "bot_api_cloud", allowLinkFallback: true });
  });

  it("only the owner can press a menu button", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE, YT);
    const data = buttonData(h, "144p");
    await send(h, callback(BOB, data));
    expect(String(h.tg.last("answerCallbackQuery")!.params.text)).toContain("مال تو نیست");
    expect((await reload(h, job)).status).toBe("ready");
    expect(h.queue.messages).toHaveLength(0);
  });

  it("garbage callback payloads are ignored", async () => {
    const h = makeHarness();
    await send(h, callback(ALICE, "q:../../etc:passwd"));
    await send(h, callback(ALICE, "q:zzzzzzzzzz:v1080")); // well-formed but unknown job
    expect(h.tg.of("answerCallbackQuery")).toHaveLength(2);
    expect(String(h.tg.last("answerCallbackQuery")!.params.text)).toContain("پیدا نشد");
  });

  it("respects the global concurrency limit with backpressure instead of failing the job", async () => {
    const h = makeHarness({ MAX_CONCURRENT_JOBS: "1", MAX_JOBS_PER_USER: "3" });
    const a = await submitAndInspect(h, ALICE, "https://v.example.com/a");
    await pressQuality(h, ALICE, a, "144p");
    const b = await submitAndInspect(h, BOB, "https://v.example.com/b");
    await pressQuality(h, BOB, b, "144p");
    await h.runQueue();
    expect(await countRunning(h.deps.db)).toBe(1);
    expect(h.backend.started).toHaveLength(1);
    const states = [(await reload(h, a)).status, (await reload(h, b)).status].sort();
    expect(states).toEqual(["downloading", "queued"]); // the second one waits in the queue
  });

  it("a redelivered download message starts the container once", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE, YT);
    await pressQuality(h, ALICE, job, "144p");
    h.queue.messages.push({ ...h.queue.messages[0]! });
    await h.runQueue();
    expect(h.backend.started).toHaveLength(1);
    expect((await reload(h, job)).attempts).toBe(1);
  });
});

describe("container events", () => {
  it("shows measured progress in Persian, throttles edits, and completes with a signed link", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "1080p60");
    h.tg.reset();
    h.advance(5); // the dispatch message was just edited; real progress arrives seconds later
    const progress = (percent: number, speed: number) => ({ type: "progress" as const, progress: { phase: "downloading" as const, percent, speedBytesPerSec: speed, etaSeconds: 83, downloadedBytes: percent * 3_100_000, totalBytes: 310_000_000, detail: "video+audio" } });
    expect((await containerEvent(h, job, progress(64, 5_200_000))).status).toBe(200);
    const first = h.tg.of("editMessageText").at(-1)!;
    expect(first.params.text).toContain("وضعیت دانلود");
    expect(first.params.text).toContain("پیشرفت: ۶۴٪");
    expect(first.params.text).toContain("سرعت: 5.2 MB/s");
    expect(first.params.text).toContain("زمان باقی‌مانده: 01:23");
    expect(first.params.text).toContain("دریافت ویدیو و صدا");
    expect(first.params.text).toContain("کیفیت: 1080p60");
    expect(first.params.reply_markup.inline_keyboard[0][0].text).toContain("لغو");
    const edits = h.tg.of("editMessageText").length;
    await containerEvent(h, job, progress(65, 5_300_000)); // within the throttle window: no new edit
    expect(h.tg.of("editMessageText").length).toBe(edits);
    h.clock.now += 5;
    await containerEvent(h, job, progress(70, 5_300_000));
    expect(h.tg.of("editMessageText").length).toBe(edits + 1);

    await containerEvent(h, job, { type: "state", status: "processing" });
    expect((await reload(h, job)).status).toBe("processing");
    await containerEvent(h, job, { type: "state", status: "uploading" });
    expect((await reload(h, job)).status).toBe("uploading");

    h.tg.reset();
    const done = await containerEvent(h, job, { type: "completed", result: linkResult() });
    expect(done.body.ok).toBe(true);
    const finished = await reload(h, job);
    expect(finished).toMatchObject({ status: "completed", delivery_mode: "r2_link" });
    expect(finished.finished_at).toBeTruthy();
    const link = h.tg.last("sendMessage")!;
    expect(link.params.text).toContain("فایل آماده شد");
    expect(link.params.text).toContain("لینک دانلود امضاشده و موقت");
    expect(link.params.reply_markup.inline_keyboard[0][0].url).toBe(linkResult().downloadUrl);
    expect(h.backend.released).toContain(job.id); // the container is stopped as soon as the job is done
  });

  it("a direct delivery needs no extra message; duplicate completion callbacks are ignored", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    await containerEvent(h, job, { type: "completed", result: directResult() });
    h.tg.reset();
    const again = await containerEvent(h, job, { type: "completed", result: directResult() });
    expect(again.status).toBe(200);
    expect(h.tg.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    expect((await reload(h, job)).status).toBe("completed");
    expect(await h.deps.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE job_id = ? AND to_status = 'completed'").bind(job.id).first<{ n: number }>().then((r) => r!.n)).toBe(1);
  });

  it("rejects callbacks with a missing, forged or other job's token", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    const other = await startDownload(h, BOB, "144p");
    expect((await containerEvent(h, job, { type: "heartbeat" }, { token: "nope" })).status).toBe(401);
    expect((await containerEvent(h, job, { type: "heartbeat" }, { token: await signJobToken(env.INTERNAL_SIGNING_SECRET, other.id) })).status).toBe(401);
    expect((await containerEvent(h, job, { type: "heartbeat" }, { token: "" })).status).toBe(401);
    expect((await containerEvent(h, job, { type: "heartbeat" })).status).toBe(200);
  });

  it("validates event payloads", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    const res = await containerEvent(h, job, { type: "state", status: "teleporting" } as never);
    expect(res.status).toBe(400);
  });

  it("a lost 'processing' callback does not block 'completed'", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    await containerEvent(h, job, { type: "completed", result: directResult() }); // downloading -> completed directly
    expect((await reload(h, job)).status).toBe("completed");
  });
});

describe("failure handling and recovery", () => {
  it("retries a transient failure with exponential backoff, then reports the final failure with a retry button", async () => {
    const h = makeHarness({ MAX_RETRIES: "1" });
    const job = await startDownload(h, ALICE, "144p");
    await containerEvent(h, job, { type: "failed", errorCode: "network_error", message: "connection reset", retryable: true });
    let row = await reload(h, job);
    expect(row).toMatchObject({ status: "retry_wait", attempts: 1, error_code: "network_error" });
    expect(row.next_retry_at).toBe(h.clock.now + 30);
    expect(h.queue.messages.at(-1)).toMatchObject({ body: { type: "download" }, delaySeconds: 30 });
    expect(h.backend.released).toContain(job.id);
    expect(h.tg.texts().at(-1)).toContain("تلاش دوباره");

    expect(await h.runQueue()).toBe(0); // the backoff has not elapsed
    h.advance(31);
    await h.runQueue(); // second attempt starts a fresh container job
    row = await reload(h, job);
    expect(row).toMatchObject({ status: "downloading", attempts: 2 });
    expect(h.backend.started).toHaveLength(2);

    await containerEvent(h, job, { type: "failed", errorCode: "network_error", message: "reset again", retryable: true });
    row = await reload(h, job);
    expect(row).toMatchObject({ status: "failed", error_code: "network_error" }); // attempts exhausted (max 2)
    const last = h.tg.last("editMessageText")!;
    expect(last.params.text).toContain("ناموفق");
    expect(last.params.reply_markup.inline_keyboard[0][0].text).toContain("تلاش دوباره");
  });

  it("does not retry permanent failures and explains them", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    await containerEvent(h, job, { type: "failed", errorCode: "geo_restricted", message: "not available in your country", retryable: false });
    expect(await reload(h, job)).toMatchObject({ status: "failed", error_code: "geo_restricted" });
    const text = String(h.tg.last("editMessageText")!.params.text);
    expect(text).toContain("محدودیت جغرافیایی");
    expect(h.tg.last("editMessageText")!.params.reply_markup.inline_keyboard).toEqual([]); // no retry button for a permanent error
  });

  it("classifies bot-check failures honestly and never claims to bypass them", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    await containerEvent(h, job, { type: "failed", errorCode: "bot_check", message: "Sign in to confirm you're not a bot", retryable: false });
    expect(String(h.tg.last("editMessageText")!.params.text)).toContain("دور نمی‌زنه");
  });

  it("when the container cannot be started the job is retried, not lost", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE, YT);
    await pressQuality(h, ALICE, job, "144p");
    h.backend.startError = new Error("no capacity");
    await h.runQueue();
    expect(await reload(h, job)).toMatchObject({ status: "retry_wait", error_code: "container_lost" });
    h.backend.startError = null;
    h.advance(31);
    await h.runQueue();
    expect((await reload(h, job)).status).toBe("downloading");
  });

  it("a user can retry a failed job manually", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    await containerEvent(h, job, { type: "failed", errorCode: "disk_full", message: "no space", retryable: true });
    await containerEvent(h, job, { type: "failed", errorCode: "ffmpeg_failed", message: "x", retryable: true });
    let row = await reload(h, job);
    while (row.status === "retry_wait") {
      h.advance(700);
      await h.runQueue();
      await containerEvent(h, job, { type: "failed", errorCode: "ffmpeg_failed", message: "x", retryable: true });
      row = await reload(h, job);
    }
    expect(row.status).toBe("failed");
    h.backend.started.length = 0;
    await send(h, callback(ALICE, buttonDataFor(h, "تلاش دوباره")));
    await h.runQueue();
    expect((await reload(h, job)).status).toBe("downloading");
    expect(h.backend.started).toHaveLength(1);
  });
});

function buttonDataFor(h: ReturnType<typeof makeHarness>, label: string): string {
  return buttonData(h, label);
}

describe("cancellation", () => {
  it("cancelling a menu that is waiting for a choice closes it", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE, YT);
    await send(h, callback(ALICE, buttonData(h, "بستن")));
    expect((await reload(h, job)).status).toBe("expired");
    expect(h.tg.of("deleteMessage").length).toBeGreaterThan(0);
  });

  it("cancels a running download, stops the container, and ignores late events from it", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "1080p60");
    await send(h, callback(ALICE, buttonData(h, "لغو"), job.status_message_id ?? 1));
    await h.drain();
    const row = await reload(h, job);
    expect(row.status).toBe("cancelled");
    expect(h.backend.cancelled).toContain(job.id);
    expect(h.backend.released).toContain(job.id);
    expect(String(h.tg.last("editMessageText")!.params.text)).toContain("لغو شد");
    const late = await containerEvent(h, job, { type: "completed", result: directResult() });
    expect(late.body.cancel).toBe(true); // tells the container to stop
    expect((await reload(h, job)).status).toBe("cancelled"); // a late completion cannot resurrect it
    const failed = await containerEvent(h, job, { type: "failed", errorCode: "cancelled", message: "x", retryable: false });
    expect(failed.status).toBe(200);
    expect((await reload(h, job)).status).toBe("cancelled");
  });

  it("/cancel stops every active job of the user and nobody else's", async () => {
    const h = makeHarness({ MAX_JOBS_PER_USER: "3" });
    const a1 = await submitAndInspect(h, ALICE, "https://x.example.com/1");
    await pressQuality(h, ALICE, a1, "144p");
    const a2 = await submitAndInspect(h, ALICE, "https://x.example.com/2");
    const b = await submitAndInspect(h, BOB, "https://x.example.com/3");
    await pressQuality(h, BOB, b, "144p");
    await send(h, userMessage(ALICE, "/cancel"));
    expect((await reload(h, a1)).status).toBe("cancelled");
    expect((await reload(h, b)).status).toBe("queued");
    expect(h.tg.texts().at(-1)).toContain("لغو شد");
    expect((await reload(h, a2)).status).toBe("ready"); // an unanswered menu is not an active job
    await send(h, userMessage(ALICE, "/cancel"));
    expect(h.tg.texts().at(-1)).toContain("دانلود فعالی برای لغو نداری");
  });
});

describe("customisation keeps title, file name, caption and embedded metadata independent", () => {
  async function customize(h: ReturnType<typeof makeHarness>, userId = ALICE) {
    await send(h, callback(userId, "s:quick:toggle")); // quickStart off => quality opens the options screen
    const job = await submitAndInspect(h, userId, `https://c.example.com/${userId}/${Math.random()}`);
    await send(h, callback(userId, buttonData(h, "720p60"), job.menu_message_id ?? 1));
    return job;
  }

  it("opens the options screen instead of starting when quick start is off", async () => {
    const h = makeHarness();
    const job = await customize(h);
    expect((await reload(h, job)).status).toBe("ready");
    const edit = h.tg.last("editMessageCaption")!;
    expect(String(edit.params.caption)).toContain("شخصی‌سازی");
    expect(String(edit.params.caption)).toContain("720p60");
    const labels = (edit.params.reply_markup.inline_keyboard as { text: string }[][]).flat().map((b) => b.text);
    for (const expected of ["🏷 عنوان", "📁 نام فایل", "📝 کپشن", "🧬 متادیتا", "🖼 کاور", "📦 فرمت", "🚚 روش تحویل", "▶️ شروع دانلود"]) expect(labels).toContain(expected);
  });

  it("title, file name, caption and embedded metadata are edited separately and reach the container as separate fields", async () => {
    const h = makeHarness();
    const job = await customize(h);
    // 1) display title
    await send(h, callback(ALICE, buttonData(h, "🏷 عنوان")));
    await send(h, userMessage(ALICE, "عنوان جدید ✨"));
    let draft = jobSelection(await reload(h, job)) as Draft;
    expect(draft).toMatchObject({ title: "عنوان جدید ✨", filename: "Big Buck Bunny", embedTitle: null });
    // 2) file name — sanitised
    await send(h, callback(ALICE, buttonData(h, "📁 نام فایل")));
    await send(h, userMessage(ALICE, "../../my:clip*1"));
    draft = jobSelection(await reload(h, job)) as Draft;
    expect(draft.filename).toBe("my clip 1");
    expect(draft.title).toBe("عنوان جدید ✨");
    // 3) caption — user HTML is escaped, placeholders survive
    await send(h, callback(ALICE, buttonData(h, "📝 کپشن")));
    await send(h, userMessage(ALICE, "<b>x</b> {title} — {size}"));
    draft = jobSelection(await reload(h, job)) as Draft;
    expect(draft.caption).toBe("&lt;b&gt;x&lt;/b&gt; {title} — {size}");
    // 4) embedded metadata: title then artist
    await send(h, callback(ALICE, buttonData(h, "🧬 متادیتا")));
    await send(h, userMessage(ALICE, "Embedded title"));
    expect(h.tg.texts().at(-1)).toContain("متادیتا"); // asks for the artist next
    await send(h, userMessage(ALICE, "Some Artist"));
    draft = jobSelection(await reload(h, job)) as Draft;
    expect(draft).toMatchObject({ embedTitle: "Embedded title", embedArtist: "Some Artist", title: "عنوان جدید ✨", filename: "my clip 1" });
    // start and verify what the container receives
    await send(h, callback(ALICE, buttonData(h, "▶️ شروع دانلود")));
    await h.runQueue();
    expect(h.backend.started[0]!.selection).toMatchObject({
      title: "عنوان جدید ✨", filename: "my clip 1", caption: "&lt;b&gt;x&lt;/b&gt; {title} — {size}", embedTitle: "Embedded title", embedArtist: "Some Artist",
    });
  });

  it("validates typed input and keeps waiting on bad input", async () => {
    const h = makeHarness();
    await customize(h);
    await send(h, callback(ALICE, buttonData(h, "🏷 عنوان")));
    await send(h, userMessage(ALICE, "x".repeat(300)));
    expect(h.tg.texts().at(-1)).toContain("خیلی بلنده");
    await send(h, callback(ALICE, buttonData(h, "📁 نام فایل")));
    await send(h, userMessage(ALICE, "***")); // only characters that are stripped from file names
    expect(h.tg.texts().at(-1)).toContain("⚠️");
    await send(h, userMessage(ALICE, "/cancel")); // abandons the prompt
    expect(h.tg.texts().at(-1)).toContain("دانلود فعالی برای لغو نداری");
  });

  it("thumbnail: custom photo is passed by Telegram file id; frame mode carries its timestamp", async () => {
    const h = makeHarness();
    const job = await customize(h);
    await send(h, callback(ALICE, buttonData(h, "🖼 کاور")));
    await send(h, callback(ALICE, buttonData(h, "آپلود تصویر دلخواه")));
    await send(h, userMessage(ALICE, "", { text: undefined, photo: [{ file_id: "small", file_unique_id: "s", width: 90, height: 90 }, { file_id: "BIG_PHOTO", file_unique_id: "b", width: 800, height: 800 }] }));
    expect(((jobSelection(await reload(h, job)) as Draft).thumbnail)).toEqual({ mode: "custom", customFileId: "BIG_PHOTO" });
    // frame preview goes through the queue (it can be slow)
    await send(h, callback(ALICE, buttonData(h, "🖼 کاور")));
    await send(h, callback(ALICE, buttonData(h, "پیش‌نمایش چند فریم")));
    expect(h.queue.messages.map((m) => m.body.type)).toEqual(["frames"]);
    await h.runQueue();
    expect(h.tg.of("sendMediaGroup")).toHaveLength(1);
    await send(h, callback(ALICE, buttonData(h, "2")));
    expect(((jobSelection(await reload(h, job)) as Draft).thumbnail)).toEqual({ mode: "frame", frameTimestamp: 20 });
    await send(h, callback(ALICE, buttonData(h, "▶️ شروع دانلود")));
    await h.runQueue();
    expect(h.backend.started[0]!.selection.thumbnail).toEqual({ mode: "frame", frameTimestamp: 20 });
  });

  it("a frame preview that cannot be produced says so honestly", async () => {
    const h = makeHarness();
    await customize(h);
    h.backend.framesOutcome = { ok: false, error: { code: "unavailable", message: "no usable preview frames could be extracted", retryable: false } };
    await send(h, callback(ALICE, buttonData(h, "🖼 کاور")));
    await send(h, callback(ALICE, buttonData(h, "پیش‌نمایش چند فریم")));
    await h.runQueue();
    expect(h.tg.texts().at(-1)).toContain("پیش‌نمایش فریم‌ها ممکن نشد");
  });

  it("the container choice is validated: WebM from H.264 needs explicit permission to re-encode", async () => {
    const h = makeHarness();
    await customize(h);
    await send(h, callback(ALICE, buttonData(h, "📦 فرمت")));
    await send(h, callback(ALICE, buttonData(h, /WebM/)));
    await send(h, callback(ALICE, buttonData(h, "▶️ شروع دانلود")));
    expect(String(h.tg.last("answerCallbackQuery")!.params.text)).toContain("cannot be copied into WebM");
    expect(h.queue.messages).toHaveLength(0);
    await send(h, callback(ALICE, buttonData(h, "📦 فرمت")));
    await send(h, callback(ALICE, buttonData(h, "اجازه‌ی تبدیل")));
    await send(h, callback(ALICE, buttonData(h, "🔙 بازگشت")));
    await send(h, callback(ALICE, buttonData(h, "▶️ شروع دانلود")));
    await h.runQueue();
    expect(h.backend.started[0]!.selection).toMatchObject({ container: "webm", allowTranscode: true });
  });

  it("an explicit 'direct Telegram' delivery cannot be chosen for a file Telegram cannot carry", async () => {
    const h = makeHarness();
    await customize(h);
    await send(h, callback(ALICE, buttonData(h, "🚚 روش تحویل")));
    await send(h, callback(ALICE, buttonData(h, "مستقیم تلگرام")));
    expect(h.tg.last("answerCallbackQuery")!.params.show_alert).toBe(true);
    await send(h, callback(ALICE, buttonData(h, "🔙 بازگشت")));
    await send(h, callback(ALICE, buttonData(h, "▶️ شروع دانلود")));
    expect(h.queue.messages).toHaveLength(0); // refused at start as well
    expect(String(h.tg.last("answerCallbackQuery")!.params.text)).toContain("exceeds");
  });

  it("the local-server mode is only selectable when it is configured", async () => {
    const h = makeHarness();
    await customize(h);
    await send(h, callback(ALICE, buttonData(h, "🚚 روش تحویل")));
    expect(allButtons(h).some((b) => b.text.includes("سرور لوکال"))).toBe(false);
    const local = makeHarness({ LOCAL_BOT_API_ENABLED: "true", TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "h" });
    await customize(local, BOB);
    await send(local, callback(BOB, buttonData(local, "🚚 روش تحویل")));
    expect(allButtons(local).some((b) => b.text.includes("سرور لوکال"))).toBe(true);
  });
});

describe("settings, history, account, admin", () => {
  it("a default-resolution setting skips the menu and starts straight away", async () => {
    const h = makeHarness();
    await send(h, userMessage(ALICE, "/settings"));
    // cycle: ask -> best -> 1080 -> 720
    for (let i = 0; i < 3; i++) await send(h, callback(ALICE, buttonData(h, "کیفیت پیش‌فرض")));
    expect(allButtons(h).some((b) => b.text.includes("720p"))).toBe(true);
    await send(h, userMessage(ALICE, YT));
    await h.runQueue();
    const job = await latestJob(h, ALICE);
    expect(job.status).toBe("downloading");
    expect(h.tg.of("sendPhoto")).toHaveLength(0); // no menu was shown
    expect(h.backend.started[0]!.selection).toMatchObject({ label: "720p60", videoFormatId: "298" });
  });

  it("settings persist and the language can be switched", async () => {
    const h = makeHarness();
    await send(h, userMessage(ALICE, "/settings"));
    await send(h, callback(ALICE, buttonData(h, "🌐 زبان")));
    await send(h, userMessage(ALICE, "/help"));
    expect(h.tg.texts().at(-1)).toContain("Help");
    await send(h, callback(ALICE, buttonData(h, "🌐 Language")));
    await send(h, userMessage(ALICE, "/help"));
    expect(h.tg.texts().at(-1)).toContain("راهنما");
  });

  it("history lists finished jobs with pagination, shows details and can be cleared", async () => {
    const h = makeHarness({ MAX_JOBS_PER_USER: "10", RATE_LIMIT_PER_MINUTE: "100" });
    for (let i = 0; i < 7; i++) {
      const job = await submitAndInspect(h, ALICE, `https://h.example.com/${i}`);
      await send(h, callback(ALICE, buttonData(h, "بستن")));
      await h.deps.db.prepare("UPDATE jobs SET status = 'completed', finished_at = ?, created_at = ? WHERE id = ?").bind(h.clock.now, h.clock.now + i, job.id).run();
    }
    await send(h, userMessage(ALICE, "/history"));
    const page1 = h.tg.last("sendMessage")!;
    expect(String(page1.params.text)).toContain("(۷ مورد · صفحه‌ی ۱ از ۲)");
    expect((String(page1.params.text).match(/✅/g) ?? []).length).toBe(5);
    await send(h, callback(ALICE, buttonData(h, "بعدی"), 888));
    expect(String(h.tg.last("editMessageText")!.params.text)).toContain("صفحه‌ی ۲ از ۲");
    await send(h, callback(ALICE, buttonData(h, "1")));
    expect(String(h.tg.last("sendMessage")!.params.text)).toContain("جزئیات دانلود");
    await send(h, callback(ALICE, buttonData(h, "پاک کردن تاریخچه"), 888));
    await send(h, callback(ALICE, buttonData(h, "بله، پاک کن"), 888));
    expect(h.tg.texts().at(-1)).toContain("۷ مورد پاک شد");
    await send(h, userMessage(ALICE, "/history"));
    expect(h.tg.texts().at(-1)).toContain("هنوز دانلودی نداشتی");
  });

  it("history details are private to their owner", async () => {
    const h = makeHarness();
    const job = await submitAndInspect(h, ALICE, YT);
    await send(h, callback(BOB, `hd:${job.short_id}`));
    expect(String(h.tg.last("answerCallbackQuery")!.params.text)).toContain("مال تو نیست");
  });

  it("/account reports totals and limits", async () => {
    const h = makeHarness();
    await submitAndInspect(h, ALICE, YT);
    await send(h, userMessage(ALICE, "/account"));
    const text = String(h.tg.last("sendMessage")!.params.text);
    expect(text).toContain("حساب کاربری");
    expect(text).toContain(`<code>${ALICE}</code>`);
  });

  it("admin commands are protected and work for administrators", async () => {
    const h = makeHarness();
    await send(h, userMessage(ALICE, "/admin stats"));
    expect(h.tg.texts().at(-1)).toContain("فقط برای ادمین");
    await send(h, callback(ALICE, "ad:stats"));
    expect(String(h.tg.last("answerCallbackQuery")!.params.text)).toContain("فقط برای ادمین");

    await send(h, userMessage(ADMIN, "/admin limits"));
    expect(h.tg.texts().at(-1)).toContain("max_output: 1.9 GB");
    await send(h, userMessage(ADMIN, "/admin set max_jobs_per_user 7"));
    expect(h.tg.texts().at(-1)).toContain("max_jobs_per_user = 7");
    await send(h, userMessage(ADMIN, "/admin set max_jobs_per_user 999"));
    expect(h.tg.texts().at(-1)).toContain("between");
    await send(h, userMessage(ADMIN, "/admin set not_a_key 1"));
    expect(h.tg.texts().at(-1)).toContain("unknown key");
    await send(h, userMessage(ADMIN, "/admin block 4242 spamming"));
    await send(h, userMessage(4242, YT));
    expect(h.tg.texts().at(-1)).toContain("مسدود");
    await send(h, userMessage(ADMIN, "/admin unblock 4242"));
    await send(h, userMessage(ADMIN, `/admin block ${ADMIN}`));
    expect(h.tg.texts().at(-1)).toContain("refusing to block an administrator");
    await send(h, userMessage(ADMIN, "/admin health"));
    const health = h.tg.texts().at(-1)!;
    expect(health).toContain("D1: ok");
    expect(health).toContain("R2: ok");
    expect(health).toContain("container: ok");
    await send(h, userMessage(ADMIN, "/admin stats"));
    expect(h.tg.texts().at(-1)).toContain("users:");
  });

  it("a Telegram send failure for one user never breaks the others", async () => {
    const h = makeHarness();
    h.tg.failNext("sendMessage", 403, "Forbidden: bot was blocked by the user", 1);
    await expect(send(h, userMessage(ALICE, "/start"))).rejects.toThrow(); // handler surfaces it; the webhook route catches and logs it
  });
});

describe("job record sanity", () => {
  it("never reuses ids and keeps every state transition in the audit log", async () => {
    const h = makeHarness();
    const job = await startDownload(h, ALICE, "144p");
    await containerEvent(h, job, { type: "state", status: "processing" });
    await containerEvent(h, job, { type: "state", status: "uploading" });
    await containerEvent(h, job, { type: "completed", result: directResult() });
    const events = await h.deps.db.prepare("SELECT from_status, to_status FROM job_events WHERE job_id = ? ORDER BY id").bind(job.id).all<{ from_status: string | null; to_status: string }>();
    expect(events.results.map((e) => e.to_status)).toEqual(["queued", "inspecting", "ready", "queued", "downloading", "processing", "uploading", "completed"]);
    expect((await getJob(h.deps.db, job.id))!.id).toBe(job.id);
  });
});

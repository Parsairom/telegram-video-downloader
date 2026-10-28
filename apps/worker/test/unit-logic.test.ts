import { JOB_STATUSES, JOB_TRANSITIONS, canTransition } from "@tvd/shared-types";
import { describe, expect, it } from "vitest";
import { CALLBACK_MAX_BYTES, encodeJob, encodeSetting, parseCallback } from "../src/callbacks/codec";
import { formatBytes, formatDuration, progressBar, sanitizeFilename, toFa } from "../src/bot/format";
import { parseAdminIds, parseConfig, validateRuntimeValue, ConfigError } from "../src/config";
import { bestWithin, buildOptions, containerCompat, pickByResolution, resolveContainer } from "../src/services/formats";
import { buildDraft, toSelection } from "../src/services/selection";
import { decideDelivery } from "../src/services/size-policy";
import { UserSettingsSchema } from "../src/db/types";
import { fmt, sampleInfo, testConfig } from "./helpers";

describe("formats → quality options (only what really exists)", () => {
  const bundle = buildOptions(sampleInfo());

  it("offers exactly the resolutions the source has, best first, plus audio", () => {
    expect(bundle.quick.filter((o) => o.kind === "video").map((o) => o.label)).toEqual(["2160p60", "1080p60", "720p60", "360p", "144p"]);
    expect(bundle.quick.at(-1)?.key).toBe("a");
    expect(bundle.quick.some((o) => o.label.includes("1440"))).toBe(false); // never invented
  });

  it("prefers H.264 (plays everywhere) at equal resolution, and a stereo AAC track for merging", () => {
    const v1080 = bundle.quick.find((o) => o.key === "v1080")!;
    expect(v1080.videoFormatId).toBe("299");
    expect(v1080.audioFormatId).toBe("140"); // not the 5.1 track (258)
    expect(v1080.needsMerge).toBe(true);
    expect(v1080.estimatedBytes).toBe(300_000_000 + 10_000_000);
  });

  it("uses a progressive stream when it is the only one at that resolution without separate audio needs", () => {
    const only = buildOptions(sampleInfo({ formats: [fmt({ formatId: "p720", kind: "video", hasAudio: true, width: 1280, height: 720, vcodec: "avc1", acodec: "mp4a", filesize: 50_000_000 })] }));
    const o = only.quick[0]!;
    expect(o.videoFormatId).toBe("p720");
    expect(o.audioFormatId).toBeNull();
    expect(o.needsMerge).toBe(false);
  });

  it("lists every distinct format in the advanced menu, with codec and dynamic range", () => {
    const ids = bundle.advanced.map((o) => o.videoFormatId);
    expect(ids).toEqual(expect.arrayContaining(["299", "303", "399", "315", "298", "134", "18", "160"]));
    const hdr = bundle.advanced.find((o) => o.videoFormatId === "315")!;
    expect(hdr.dynamicRange).toBe("HDR10");
  });

  it("labels vertical video by its short side", () => {
    const v = buildOptions(sampleInfo({ formats: [fmt({ formatId: "v", kind: "video", hasAudio: true, width: 1080, height: 1920, vcodec: "avc1", acodec: "aac" })] }));
    expect(v.quick[0]!.label).toBe("1080p");
    expect(v.quick[0]!.height).toBe(1080);
  });

  it("handles a source with no resolution info and an audio-only source", () => {
    const direct = buildOptions(sampleInfo({ formats: [fmt({ formatId: "direct", kind: "video", hasAudio: true, vcodec: null, acodec: null })] }));
    expect(direct.quick[0]).toMatchObject({ key: "best", label: "Best", kind: "video" });
    const audioOnly = buildOptions(sampleInfo({ formats: [fmt({ formatId: "m", kind: "audio", ext: "mp3", acodec: "mp3" })] }));
    expect(audioOnly.quick.map((o) => o.key)).toEqual(["a"]);
  });

  it("offers an audio-language menu only when several languages exist", () => {
    expect(bundle.audioTracks).toHaveLength(0);
    const multi = buildOptions(sampleInfo({ formats: [
      fmt({ formatId: "a-en", kind: "audio", ext: "m4a", acodec: "mp4a", audioLanguage: "en" }),
      fmt({ formatId: "a-de", kind: "audio", ext: "m4a", acodec: "mp4a", audioLanguage: "de" }),
      fmt({ formatId: "v", kind: "video", width: 1280, height: 720, vcodec: "avc1" }),
    ] }));
    expect(multi.audioTracks.map((o) => o.audioFormatId).sort()).toEqual(["a-de", "a-en"]);
    expect(multi.quick.find((o) => o.key === "v720")?.audioLanguage).toBeTruthy();
  });

  it("picks quality by preference", () => {
    expect(pickByResolution(bundle, 1080)?.key).toBe("v1080");
    expect(pickByResolution(bundle, 900)?.key).toBe("v720"); // closest lower
    expect(pickByResolution(bundle, 100)?.key).toBe("v144"); // nothing lower: the lowest available
    expect(bestWithin(bundle, 1_900_000_000)?.key).toBe("v1080"); // 2160p estimate (2.4 GB) is over the ceiling
    expect(bestWithin(bundle, 4_000_000_000)?.key).toBe("v2160");
  });
});

describe("container compatibility", () => {
  it("mirrors the container's remux rules", () => {
    expect(containerCompat("avc1", "mp4a", "mp4").ok).toBe(true);
    expect(containerCompat("vp9", "opus", "webm").ok).toBe(true);
    expect(containerCompat("avc1", "aac", "webm").ok).toBe(false);
    expect(containerCompat("vp8", "vorbis", "mp4").ok).toBe(false);
    expect(containerCompat("anything", "whatever", "mkv").ok).toBe(true);
    expect(containerCompat(null, "opus", "m4a").ok).toBe(false);
  });
  it("resolves 'auto' to MP4 only when copying is possible", () => {
    expect(resolveContainer("auto", "avc1", "mp4a")).toBe("mp4");
    expect(resolveContainer("auto", "vp8", "vorbis")).toBe("original");
    expect(resolveContainer("webm", "avc1", "aac")).toBe("webm");
  });
});

describe("file-size / delivery policy (bytes)", () => {
  const cfg = testConfig();
  const local = testConfig({ LOCAL_BOT_API_ENABLED: "true", TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "abc", TELEGRAM_DELIVERY_MODE: "auto" });

  it("auto: direct up to the cloud limit, link above it", () => {
    expect(decideDelivery(30_000_000, false, cfg).mode).toBe("bot_api_cloud");
    expect(decideDelivery(30_000_000, false, cfg).badge).toBe("direct");
    const big = decideDelivery(900_000_000, false, cfg);
    expect(big).toMatchObject({ mode: "r2_link", badge: "link" });
  });
  it("auto with an unknown size tries Telegram and keeps a link fallback", () => {
    expect(decideDelivery(null, false, cfg)).toMatchObject({ mode: "bot_api_cloud", allowLinkFallback: true });
  });
  it("uncertain estimates get a 10% safety margin", () => {
    expect(decideDelivery(46_000_000, false, cfg).mode).toBe("bot_api_cloud");
    expect(decideDelivery(46_000_000, true, cfg).mode).toBe("r2_link");
  });
  it("rejects anything above the application ceiling", () => {
    expect(decideDelivery(1_900_000_001, false, cfg)).toMatchObject({ mode: null, rejected: "exceeds_max", badge: "rejected" });
    expect(decideDelivery(2_100_000_000, false, cfg, "r2_link").mode).toBeNull();
  });
  it("explicit modes never silently change", () => {
    expect(decideDelivery(60_000_000, false, cfg, "bot_api_cloud")).toMatchObject({ mode: null, rejected: "exceeds_mode" });
    expect(decideDelivery(60_000_000, false, cfg, "r2_link").mode).toBe("r2_link");
    expect(decideDelivery(10_000_000, false, cfg, "bot_api_local")).toMatchObject({ mode: null, rejected: "mode_unavailable" });
    expect(decideDelivery(1_500_000_000, false, local, "bot_api_local").mode).toBe("bot_api_local");
  });
  it("auto prefers the local server over a link when it is enabled and the file fits", () => {
    expect(decideDelivery(900_000_000, false, local).mode).toBe("bot_api_local");
    expect(decideDelivery(1_850_000_000, false, local).mode).toBe("bot_api_local");
  });
  it("an operator policy overrides user preference", () => {
    const forced = testConfig({ TELEGRAM_DELIVERY_MODE: "r2_link" });
    expect(decideDelivery(1_000_000, false, forced, "bot_api_cloud").mode).toBe("r2_link");
  });
  it("the limits are plain byte counts", () => {
    expect(cfg.maxOutputBytes).toBe(1_900_000_000);
    expect(cfg.cloudUploadLimitBytes).toBe(50_000_000);
    expect(cfg.localUploadLimitBytes).toBe(2_000_000_000);
  });
});

describe("draft selection", () => {
  const info = sampleInfo();
  const bundle = buildOptions(info);
  const settings = UserSettingsSchema.parse({});
  const cfg = testConfig();

  it("builds a complete container-ready selection from an option", () => {
    const { draft, decision } = buildDraft({ info, option: bundle.quick.find((o) => o.key === "v720")!, settings, cfg });
    expect(decision.mode).toBe("r2_link"); // 80 MB video + 10 MB audio is above the 50 MB Telegram limit
    expect(draft).toMatchObject({
      kind: "video", videoFormatId: "298", audioFormatId: "140", container: "mp4", deliveryMode: "r2_link", allowLinkFallback: false,
      expectedHeight: 720, allowTranscode: false, thumbnail: { mode: "original" }, sendAs: "auto", estimatedBytes: 90_000_000, label: "720p60",
    });
    const small = buildDraft({ info, option: bundle.quick.find((o) => o.key === "v144")!, settings, cfg });
    expect(small.decision.mode).toBe("bot_api_cloud");
    expect(small.draft.allowLinkFallback).toBe(true);
  });

  it("keeps display title, file name and caption as independent fields", () => {
    const { draft } = buildDraft({ info, option: bundle.quick.find((o) => o.key === "v360")!, settings, cfg });
    expect(draft.title).toBe("Big Buck Bunny");
    expect(draft.filename).toBe("Big Buck Bunny");
    expect(draft.caption).toContain("{title}");
    const edited = buildDraft({ info, option: bundle.quick.find((o) => o.key === "v144")!, settings, cfg, previous: { ...draft, title: "Custom", filename: "my-file", caption: "<b>x</b>" } }).draft;
    expect(edited).toMatchObject({ title: "Custom", filename: "my-file", caption: "<b>x</b>" });
  });

  it("strips worker-only fields before the selection reaches the container", () => {
    const { draft } = buildDraft({ info, option: bundle.quick[0]!, settings, cfg });
    const sel = toSelection({ ...draft, frameChoices: [1, 2] });
    expect(sel).not.toHaveProperty("optionKey");
    expect(sel).not.toHaveProperty("deliveryPref");
    expect(sel).not.toHaveProperty("frameChoices");
    expect(sel.videoFormatId).toBe("315");
  });

  it("embeds metadata only when the user asked for it", () => {
    const off = buildDraft({ info, option: bundle.quick[2]!, settings, cfg }).draft;
    expect(off.embedTitle).toBeNull();
    const on = buildDraft({ info, option: bundle.quick[2]!, settings: { ...settings, embedMetadata: true }, cfg }).draft;
    expect(on.embedTitle).toBe("Big Buck Bunny");
    expect(on.embedArtist).toBe("Blender");
  });
});

describe("job state machine definition", () => {
  it("covers every status and only allows the documented transitions", () => {
    expect(Object.keys(JOB_TRANSITIONS).sort()).toEqual([...JOB_STATUSES].sort());
    expect(canTransition("queued", "inspecting")).toBe(true);
    expect(canTransition("inspecting", "ready")).toBe(true);
    expect(canTransition("ready", "queued")).toBe(true);
    expect(canTransition("queued", "downloading")).toBe(true);
    expect(canTransition("downloading", "processing")).toBe(true);
    expect(canTransition("processing", "uploading")).toBe(true);
    expect(canTransition("uploading", "completed")).toBe(true);
    expect(canTransition("downloading", "retry_wait")).toBe(true);
    expect(canTransition("retry_wait", "downloading")).toBe(true);
    // illegal
    expect(canTransition("completed", "downloading")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
    expect(canTransition("downloading", "completed")).toBe(false);
    expect(canTransition("ready", "downloading")).toBe(false);
    expect(canTransition("expired", "ready")).toBe(false);
  });
});

describe("callback_data codec", () => {
  it("round-trips job, setting, history and admin payloads within Telegram's 64 byte limit", () => {
    const data = encodeJob("q", "abcDEF1234", "v1080");
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
    expect(parseCallback(data)).toEqual({ kind: "job", action: "q", shortId: "abcDEF1234", arg: "v1080" });
    expect(parseCallback(encodeJob("go", "abcDEF1234"))).toEqual({ kind: "job", action: "go", shortId: "abcDEF1234", arg: null });
    expect(parseCallback(encodeSetting("res", "next"))).toEqual({ kind: "setting", key: "res", value: "next" });
    expect(parseCallback("h:3")).toEqual({ kind: "history", sub: "page", arg: "3" });
    expect(parseCallback("hcy")).toEqual({ kind: "history", sub: "clear_yes", arg: null });
    expect(parseCallback("ad:stats")).toEqual({ kind: "admin", sub: "stats", arg: null });
  });
  it("treats malformed or hostile payloads as noop", () => {
    for (const bad of ["", "zz:abc", "q:../../x:v1", "q:abcDEF1234:v 1", "q:short:v1", "q:abcDEF1234:" + "x".repeat(40), "x".repeat(65), "s:a", "h:abc", "go:abc def"]) {
      expect(parseCallback(bad).kind, bad).toBe("noop");
    }
    expect(parseCallback(undefined).kind).toBe("noop");
  });
  it("refuses to encode an oversized payload", () => {
    expect(() => encodeJob("q", "abcDEF1234", "x".repeat(80))).toThrow();
  });
});

describe("formatting helpers", () => {
  it("formats numbers for Persian text", () => {
    expect(toFa("64%")).toBe("۶۴%");
    expect(formatBytes(5_200_000)).toBe("5.2 MB");
    expect(formatBytes(1_900_000_000)).toBe("1.9 GB");
    expect(formatBytes(null)).toBe("—");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(65)).toBe("01:05");
    expect(progressBar(50, 10)).toBe("▰▰▰▰▰▱▱▱▱▱");
    expect(progressBar(150, 4)).toBe("▰▰▰▰");
  });
  it("sanitises file names", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("etc passwd");
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(sanitizeFilename("con")).toBe("_con");
    expect(sanitizeFilename("   ...   ")).toBe("");
    expect(sanitizeFilename("x".repeat(300))).toHaveLength(120);
    expect(sanitizeFilename("a\u202eb\u200bc")).toBe("abc");
    expect(sanitizeFilename("-rf evil")).toBe("rf evil");
    expect(sanitizeFilename("سلام دنیا")).toBe("سلام دنیا");
  });
});

describe("configuration validation", () => {
  it("parses defaults and rejects nonsense with a readable error", () => {
    const cfg = parseConfig({});
    expect(cfg.maxOutputBytes).toBe(1_900_000_000);
    expect(cfg.maxConcurrentJobs).toBe(3);
    expect(cfg.deliveryPolicy).toBe("auto");
    expect(() => parseConfig({ MAX_OUTPUT_BYTES: "not-a-number" })).toThrow(ConfigError);
    expect(() => parseConfig({ MAX_CONCURRENT_JOBS: "0" })).toThrow(/MAX_CONCURRENT_JOBS/);
    expect(() => parseConfig({ TELEGRAM_DELIVERY_MODE: "teleport" })).toThrow(ConfigError);
    expect(() => parseConfig({ TELEGRAM_DELIVERY_MODE: "bot_api_local" })).toThrow(/LOCAL_BOT_API_ENABLED/);
    expect(() => parseConfig({ TELEGRAM_DELIVERY_MODE: "r2_link" })).toThrow(/PUBLIC_BASE_URL/);
  });
  it("parses administrator ids and validates runtime overrides", () => {
    expect([...parseAdminIds("1001, 1002;abc  1003")]).toEqual([1001, 1002, 1003]);
    expect(validateRuntimeValue("max_concurrent_jobs", 4)).toBeNull();
    expect(validateRuntimeValue("max_concurrent_jobs", 0)).toMatch(/between/);
    expect(validateRuntimeValue("rate_limit_per_minute", 1.5)).toMatch(/integer/);
  });
});

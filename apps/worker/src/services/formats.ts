/**
 * Turns the formats the extractor really reported into the choices shown to the user.
 * Nothing is invented: every option maps to concrete format ids that exist in the source.
 */
import type { InspectResult, MediaFormat, OutputContainer, QualityOption } from "@tvd/shared-types";

export interface OptionsBundle {
  /** one entry per available resolution, best first, plus the audio-only option */
  quick: QualityOption[];
  /** every distinct video format (resolution × fps × codec × dynamic range), best first */
  advanced: QualityOption[];
  /** one audio option per distinct audio language (only when the source has several) */
  audioTracks: QualityOption[];
}

const MP4_VIDEO = ["avc", "h264", "hev", "hvc", "h265", "av01", "av1", "vp9", "vp09", "mp4v", "mpeg4"];
const MP4_AUDIO = ["mp4a", "aac", "mp3", "ac-3", "ac3", "ec-3", "eac3", "opus", "flac", "alac"];
const WEBM_VIDEO = ["vp8", "vp9", "vp09", "av01", "av1"];
const WEBM_AUDIO = ["opus", "vorbis"];

const starts = (value: string | null | undefined, prefixes: string[]) => {
  const v = (value ?? "").toLowerCase();
  return prefixes.some((p) => v.startsWith(p));
};

/** Mirror of apps/media-container/app/formats.py::container_compat — can the streams be copied into `container`? */
export function containerCompat(vcodec: string | null, acodec: string | null, container: OutputContainer): { ok: boolean; reason?: string } {
  const hasV = Boolean(vcodec);
  const hasA = Boolean(acodec);
  switch (container) {
    case "original":
    case "mkv":
    case "mp3":
      return { ok: true };
    case "m4a":
      if (hasA && !starts(acodec, ["mp4a", "aac", "alac", "ac-3", "ac3", "ec-3", "eac3", "mp3"])) return { ok: false, reason: `audio codec ${acodec} cannot be copied into M4A` };
      return { ok: true };
    case "mp4":
      if (hasV && !starts(vcodec, MP4_VIDEO)) return { ok: false, reason: `video codec ${vcodec} cannot be copied into MP4` };
      if (hasA && !starts(acodec, MP4_AUDIO)) return { ok: false, reason: `audio codec ${acodec} cannot be copied into MP4` };
      return { ok: true };
    case "webm":
      if (hasV && !starts(vcodec, WEBM_VIDEO)) return { ok: false, reason: `video codec ${vcodec} cannot be copied into WebM` };
      if (hasA && !starts(acodec, WEBM_AUDIO)) return { ok: false, reason: `audio codec ${acodec} cannot be copied into WebM` };
      return { ok: true };
  }
}

/** "auto" = MP4 whenever the streams can be copied into it (best Telegram playback), otherwise keep the original. */
export function resolveContainer(pref: "auto" | "mp4" | "webm" | "original", vcodec: string | null, acodec: string | null): OutputContainer {
  if (pref === "auto") return containerCompat(vcodec, acodec, "mp4").ok ? "mp4" : "original";
  return pref;
}

const shortSide = (f: MediaFormat): number | null => {
  if (f.width && f.height) return Math.min(f.width, f.height);
  return f.height ?? f.width;
};

function codecRank(vcodec: string | null): number {
  const v = (vcodec ?? "").toLowerCase();
  if (v.startsWith("avc") || v.startsWith("h264")) return 4;
  if (v.startsWith("hev") || v.startsWith("hvc") || v.startsWith("h265")) return 3;
  if (v.startsWith("vp9") || v.startsWith("vp09")) return 2;
  if (v.startsWith("vp8")) return 1;
  return 0; // av1 / unknown: least widely playable inside Telegram
}

export function codecLabel(vcodec: string | null): string {
  const v = (vcodec ?? "").toLowerCase();
  if (v.startsWith("avc") || v.startsWith("h264")) return "H.264";
  if (v.startsWith("hev") || v.startsWith("hvc") || v.startsWith("h265")) return "HEVC";
  if (v.startsWith("vp9") || v.startsWith("vp09")) return "VP9";
  if (v.startsWith("vp8")) return "VP8";
  if (v.startsWith("av01") || v.startsWith("av1")) return "AV1";
  return v ? v.split(".")[0]!.toUpperCase() : "";
}

function videoRank(f: MediaFormat): number[] {
  const sdr = f.dynamicRange === null || f.dynamicRange === "SDR" ? 1 : 0; // default to SDR unless HDR is all there is
  return [sdr, codecRank(f.vcodec), f.fps ?? 0, f.ext === "mp4" ? 1 : 0, f.tbr ?? 0, f.filesize ?? 0];
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function audioRank(f: MediaFormat, preferMp4: boolean): number[] {
  const note = (f.note ?? "").toLowerCase();
  const aac = starts(f.acodec, ["mp4a", "aac"]) || f.ext === "m4a" ? 1 : 0;
  return [
    note.includes("default") || note.includes("original") ? 1 : 0,
    (f.audioChannels ?? 2) <= 2 ? 1 : 0, // stereo beats 5.1: smaller and plays everywhere
    preferMp4 ? aac : 0,
    f.tbr ?? 0,
  ];
}

export function bestAudio(audios: MediaFormat[], preferMp4: boolean, language?: string | null): MediaFormat | null {
  const pool = language === undefined ? audios : audios.filter((a) => (a.audioLanguage ?? "") === (language ?? ""));
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => compare(audioRank(b, preferMp4), audioRank(a, preferMp4)))[0] ?? null;
}

interface SizeInfo {
  bytes: number | null;
  approx: boolean;
}
function combinedSize(video: MediaFormat | null, audio: MediaFormat | null): SizeInfo {
  const parts = [video, audio].filter((f): f is MediaFormat => f !== null);
  if (parts.length === 0) return { bytes: null, approx: false };
  const known = parts.filter((p) => p.filesize);
  if (known.length === 0) return { bytes: null, approx: false };
  const missing = known.length < parts.length;
  return { bytes: known.reduce((s, p) => s + (p.filesize ?? 0), 0), approx: missing || known.some((p) => p.filesizeApprox) };
}

function label(res: number | null, fps: number | null): string {
  if (!res) return "?";
  return `${res}p${fps && fps > 31 ? Math.round(fps) : ""}`;
}

function optionFor(video: MediaFormat, audio: MediaFormat | null, key: string, labelText?: string): QualityOption {
  const size = combinedSize(video, video.hasAudio ? null : audio);
  const res = shortSide(video);
  return {
    key,
    kind: "video",
    label: labelText ?? label(res, video.fps),
    height: res,
    fps: video.fps,
    videoFormatId: video.formatId,
    audioFormatId: video.hasAudio ? null : (audio?.formatId ?? null),
    ext: video.ext,
    vcodec: video.vcodec,
    acodec: video.hasAudio ? video.acodec : (audio?.acodec ?? null),
    dynamicRange: video.dynamicRange && video.dynamicRange !== "SDR" ? video.dynamicRange : null,
    audioLanguage: audio?.audioLanguage ?? null,
    estimatedBytes: size.bytes,
    estimateIsApprox: size.approx,
    needsMerge: !video.hasAudio && audio !== null,
  };
}

export function buildOptions(info: InspectResult): OptionsBundle {
  const videos = info.formats.filter((f) => f.kind === "video" && (f.height || f.width));
  const audios = info.formats.filter((f) => f.kind === "audio");
  const quick: QualityOption[] = [];
  const advanced: QualityOption[] = [];

  const audioFor = (v: MediaFormat) => (v.hasAudio ? null : bestAudio(audios, containerCompat(v.vcodec, "mp4a", "mp4").ok));

  // one quick option per resolution
  const byRes = new Map<number, MediaFormat[]>();
  for (const v of videos) {
    const res = shortSide(v);
    if (res) byRes.set(res, [...(byRes.get(res) ?? []), v]);
  }
  for (const res of [...byRes.keys()].sort((a, b) => b - a)) {
    const group = byRes.get(res)!;
    const hasSeparateAudio = audios.length > 0;
    const candidates = hasSeparateAudio ? group.filter((f) => !f.hasAudio) : group;
    const pool = candidates.length ? candidates : group;
    const best = [...pool].sort((a, b) => compare(videoRank(b), videoRank(a)))[0]!;
    const fps = Math.max(...group.map((g) => g.fps ?? 0));
    quick.push(optionFor(best, audioFor(best), `v${res}`, label(res, fps || null)));
  }

  // advanced: every distinct video format
  const seen = new Set<string>();
  const sorted = [...videos].sort((a, b) => (shortSide(b) ?? 0) - (shortSide(a) ?? 0) || compare(videoRank(b), videoRank(a)));
  sorted.forEach((v, i) => {
    const sig = `${v.formatId}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    advanced.push(optionFor(v, audioFor(v), `x${i}`));
  });

  // nothing with a known resolution (direct file, odd site)
  if (quick.length === 0) {
    const any = info.formats.find((f) => f.kind === "video");
    if (any) quick.push({ ...optionFor(any, audioFor(any), "best", "Best"), height: null });
  }

  // audio
  const anyAudio = bestAudio(audios, true) ?? info.formats.find((f) => f.hasAudio) ?? null;
  if (anyAudio) {
    const duration = info.durationSeconds;
    quick.push({
      key: "a",
      kind: "audio",
      label: "MP3",
      height: null,
      fps: null,
      videoFormatId: null,
      audioFormatId: anyAudio.formatId,
      ext: "mp3",
      vcodec: null,
      acodec: anyAudio.acodec,
      dynamicRange: null,
      audioLanguage: anyAudio.audioLanguage,
      estimatedBytes: duration ? Math.round((192_000 / 8) * duration) : anyAudio.filesize,
      estimateIsApprox: true,
      needsMerge: false,
    });
  }

  const languages = [...new Set(audios.map((a) => a.audioLanguage ?? ""))];
  const audioTracks: QualityOption[] = [];
  if (languages.length > 1) {
    languages.forEach((lang, i) => {
      const a = bestAudio(audios, true, lang);
      if (!a) return;
      audioTracks.push({
        key: `a${i}`, kind: "audio", label: lang || "default", height: null, fps: null, videoFormatId: null, audioFormatId: a.formatId,
        ext: "mp3", vcodec: null, acodec: a.acodec, dynamicRange: null, audioLanguage: a.audioLanguage,
        estimatedBytes: info.durationSeconds ? Math.round((192_000 / 8) * info.durationSeconds) : a.filesize,
        estimateIsApprox: true, needsMerge: false,
      });
    });
  }

  return { quick, advanced, audioTracks };
}

/** Human description of an advanced option: "1080p60 · VP9 · HDR10 · WEBM". */
export function describeOption(o: QualityOption): string {
  const parts = [o.label, codecLabel(o.vcodec), o.dynamicRange, o.ext.toUpperCase()].filter(Boolean);
  return parts.join(" · ");
}

export function findOption(bundle: OptionsBundle, key: string): QualityOption | null {
  return [...bundle.quick, ...bundle.advanced, ...bundle.audioTracks].find((o) => o.key === key) ?? null;
}

/** Highest resolution whose (known) size fits `ceilingBytes`; unknown sizes are allowed. */
export function bestWithin(bundle: OptionsBundle, ceilingBytes: number): QualityOption | null {
  const videos = bundle.quick.filter((o) => o.kind === "video");
  return videos.find((o) => o.estimatedBytes === null || o.estimatedBytes <= ceilingBytes) ?? videos[videos.length - 1] ?? null;
}

/** Option matching a preferred resolution: exact, otherwise the closest lower one, otherwise the lowest. */
export function pickByResolution(bundle: OptionsBundle, preferred: number): QualityOption | null {
  const videos = bundle.quick.filter((o) => o.kind === "video" && o.height);
  if (videos.length === 0) return null;
  return videos.find((o) => (o.height ?? 0) <= preferred) ?? videos[videos.length - 1] ?? null;
}

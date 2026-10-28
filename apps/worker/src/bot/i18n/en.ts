import type { ErrorCode } from "@tvd/shared-types";
import { clip, escapeHtml as e, formatBytes, formatDuration, formatSpeed, progressBar } from "../format";
import type { CustomizeData, MenuData, MenuLine, Messages, StatusData } from "./fa";

const BADGE = { direct: "📤", link: "🔗", rejected: "🚫" } as const;

const errorTexts: Record<ErrorCode, string> = {
  invalid_url: "❌ That link is not valid. Send a full address starting with http:// or https://.",
  blocked_url: "🚫 This address is not allowed (internal, local or non-public addresses are never processed).",
  unsupported_site: "❓ This site or link type is not supported, or no video was found.",
  private_video: "🔒 This video is private or members-only and cannot be downloaded without access.",
  login_required: "🔑 This content requires a login (or age confirmation). The bot never asks for passwords or cookies and does not bypass access controls.",
  geo_restricted: "🌍 This video is not available from the bot server's region (geo restriction).",
  unavailable: "🗑 The video was removed, the link expired, or it is no longer available.",
  drm_protected: "🛡 This video is DRM-protected and will not be downloaded.",
  rate_limited: "⏳ The source site is temporarily rate-limiting requests. Try again in a few minutes.",
  bot_check: "🤖 The source site flagged the request as a bot (\"confirm you're not a bot\" or blocked server IPs). The bot does not bypass these protections; try another link or later.",
  network_error: "📡 Could not reach the source site, or the connection dropped midway.",
  too_large: "📦 The file is larger than the allowed limit.",
  too_long: "⏱ This video is longer than the allowed duration.",
  format_unavailable: "🎞 The selected format is unavailable, or it cannot be placed in the requested container without re-encoding.",
  ffmpeg_failed: "🛠 Video processing (FFmpeg) failed.",
  validation_failed: "🧪 The output file failed the final check (the video was corrupt or incomplete).",
  upload_failed: "📤 Uploading the file to Telegram failed.",
  telegram_error: "✉️ Telegram rejected the file.",
  timeout: "⌛ The operation timed out.",
  cancelled: "🚫 The operation was cancelled.",
  container_lost: "♻️ The processing server restarted midway.",
  disk_full: "💾 The processing server ran out of temporary space.",
  internal: "⚠️ An internal error occurred.",
};

export const en: Messages = {
  lang: "en",
  labels: {
    download: "🎬 Download video",
    settings: "⚙️ Settings",
    history: "📂 Download history",
    help: "❓ Help",
    account: "👤 My account",
  },
  commands: [
    { command: "start", description: "Start and main menu" },
    { command: "help", description: "Help" },
    { command: "settings", description: "Settings" },
    { command: "history", description: "Download history" },
    { command: "cancel", description: "Cancel active downloads" },
    { command: "privacy", description: "Privacy" },
  ],
  welcome: (name) =>
    `Hi${name ? ` ${e(name)}` : ""}! 👋\n\nSend a video link from any supported site — no need to open a menu first.\n\n` +
    `🔎 I read the real video info\n📺 I show the available qualities with sizes\n🖼 You can customise cover, title and caption\n📤 I verify the final file and send it`,
  help:
    `<b>Help</b>\n\n1️⃣ Send a video link.\n2️⃣ Pick one of the real available qualities.\n3️⃣ Optionally use "✨ Customise" for cover, title, file name and caption.\n` +
    `4️⃣ Watch progress here and cancel any time.\n\n📤 = the file is sent directly in Telegram; 🔗 = it is larger than Telegram's send limit, so you get a temporary signed download link.\n\n` +
    `<b>Commands:</b> /settings · /history · /cancel · /privacy\n\n⚠️ Only download content you are allowed to download. DRM, private or login-protected content is not supported.`,
  privacy:
    `<b>Privacy</b>\n\n• Only your Telegram ID, settings and download history (link, quality, result) are stored.\n• Video files are not kept by default; they are deleted after delivery. Temporary download links expire and are deleted.\n` +
    `• The bot never asks for site passwords or cookies.\n• Use /history to clear your history.`,
  sendLink: "🔗 Send the video link right here.",
  unknownInput: "I did not understand. Send a video link or use the menu below.",

  inspecting: "🔎 Checking the link and extracting video info...",
  invalidUrl: errorTexts.invalid_url,
  blockedUrl: (reason) => `${errorTexts.blocked_url}\n<i>${e(reason)}</i>`,
  rateLimited: (sec) => `⏳ You are sending requests too fast. Try again in ${sec}s.`,
  tooManyActive: (n) => `⚠️ You already have ${n} active downloads. Wait for one to finish or use /cancel.`,
  queueFull: "🚦 The server is busy and the queue is full. Try again in a few minutes.",
  engineOffline: "🔌 The download engine is offline right now (it runs on the admin's computer). Send the link again a bit later.",
  alreadyProcessing: "♻️ This link is already being processed. The result will appear here.",
  blocked: (reason) => `⛔ Your access to this bot has been blocked.${reason ? `\n<i>${e(reason)}</i>` : ""}`,
  maintenance: "🛠 The bot is temporarily under maintenance. Try again shortly.",
  notYourItem: "This item is not yours.",
  jobNotFound: "That item was not found (it may be old). Send the link again.",
  menuExpired: "⌛ This menu expired. Send the link again.",
  error: (code, detail) => `${errorTexts[code]}${detail ? `\n<i>${e(clip(detail, 300))}</i>` : ""}`,
  playlistPrompt: (title, count, shown) => `📚 <b>${e(clip(title || "Video list", 120))}</b>\nThis link has ${count} videos${count > shown ? ` (first ${shown} shown)` : ""}. Pick one:`,

  menuCaption: (d: MenuData) => {
    const meta = [`🌐 ${e(d.site)}`, d.duration ? `⏱ ${formatDuration(d.duration)}` : null, d.uploader ? `👤 ${e(clip(d.uploader, 40))}` : null].filter(Boolean).join(" · ");
    const lines = d.lines.slice(0, 14).map((l) => `• ${l.label}${l.size ? ` — ${l.approx ? "≈" : ""}${formatBytes(l.size)}` : ""} ${BADGE[l.badge]}`);
    return `🎬 <b>${e(clip(d.title, 180))}</b>\n${meta}\n\n📺 <b>Available qualities:</b>\n${lines.join("\n")}${d.hasAudio ? "\n• 🎵 Audio only (MP3)" : ""}\n\n📤 sent in Telegram · 🔗 download link · 🚫 over the limit\n👇 Pick a quality:`;
  },
  btnQuality: (label, size, approx, badge: MenuLine["badge"]) =>
    `${badge === "rejected" ? "🚫" : "🎬"} ${label}${size ? ` · ${approx ? "≈" : ""}${formatBytes(size)}` : ""}${badge === "rejected" ? "" : ` ${BADGE[badge]}`}`,
  btnBest: "⭐ Best quality",
  btnAudio: (size) => `🎵 Audio only (MP3)${size ? ` · ≈${formatBytes(size)}` : ""}`,
  btnAdvanced: "🎛 Advanced formats",
  btnAudioTracks: "🌐 Audio language",
  btnCustomize: "✨ Customise",
  btnCancel: "❌ Cancel",
  btnBack: "🔙 Back",
  btnStart: "▶️ Start download",
  btnClose: "✖️ Close",
  btnRetry: "🔁 Try again",
  btnDownloadLink: "⬇️ Download file",
  rejectedAlert: (why) => `This option cannot be delivered: ${why}. Pick another or change the delivery method under Customise.`,
  advancedTitle: (page, pages) => `🎛 <b>Advanced formats</b> (page ${page} of ${pages})\nReal resolution, frame rate, codec and dynamic range of each format:`,
  audioTracksTitle: "🌐 <b>Audio language</b>\nAvailable audio tracks for this video:",

  customizeText: (d: CustomizeData) =>
    `✨ <b>Customise</b>\n\n📺 Selected: <b>${e(d.label)}</b>${d.estimatedBytes ? ` · ≈${formatBytes(d.estimatedBytes)}` : ""}\n` +
    `🏷 Display title: ${e(clip(d.title, 80))}\n📁 File name: <code>${e(clip(d.filename, 80))}</code>\n` +
    `📝 Caption: ${e(clip(d.caption.replace(/\{[a-z]+\}/g, "…"), 80))}\n` +
    `🧬 Embedded metadata: ${d.embedTitle || d.embedArtist ? `${e(d.embedTitle ?? "—")} / ${e(d.embedArtist ?? "—")}` : "unchanged"}\n` +
    `🖼 Cover: ${{ original: "original", frame: "frame from video", custom: "custom image", none: "none" }[d.thumbnail]}\n` +
    `📦 Container: ${e(d.container)}${d.transcode ? " (re-encode)" : ""}\n` +
    `🚚 Delivery: ${{ bot_api_cloud: "directly in Telegram", bot_api_local: "directly (local server)", mtproto: "directly in Telegram (up to 2 GB)", r2_link: "download link" }[d.delivery]} ${BADGE[d.badge]}\n` +
    `🎞 Send as: ${{ auto: "automatic", video: "video", document: "file" }[d.sendAs]}`,
  btnThumbnail: "🖼 Cover",
  btnTitle: "🏷 Title",
  btnFilename: "📁 File name",
  btnCaption: "📝 Caption",
  btnMetadata: "🧬 Metadata",
  btnContainer: "📦 Container",
  btnDelivery: "🚚 Delivery",
  btnSendAs: (v) => `🎞 Send as: ${v === "document" ? "file" : v === "video" ? "video" : "auto"}`,
  thumbMenu: "🖼 <b>Cover (thumbnail)</b>\nA Telegram cover must be a JPEG under 200 kB and at most 320 px; the bot converts your image for you.",
  thumbOptions: { original: "🖼 Original cover", frame: "🎞 Frame from video", preview: "👁 Preview several frames", upload: "📤 Upload my own image", none: "🚫 No cover" },
  thumbSet: (mode) => `✅ Cover set to "${mode}".`,
  framesLoading: "🎞 Extracting a few frames from the video...",
  framesCaption: (i, t) => `Frame ${i} · ${formatDuration(t)}`,
  framesPick: "Which frame should be the cover?",
  framesFailed: (why) => `⚠️ Frame preview is not possible (${e(why)}). You can still choose "Frame from video"; it is built after the download.`,
  askThumbnail: "🖼 Send your image as a photo (send /cancel to abort).",
  askTitle: (current) => `🏷 Send the new display title.\nCurrent: <code>${e(clip(current, 100))}</code>`,
  askFilename: (current) => `📁 Send the new file name (no extension; it is added automatically).\nCurrent: <code>${e(clip(current, 100))}</code>`,
  askCaption: (current) =>
    `📝 Send the new caption (max 900 characters).\nPlaceholders: <code>{title}</code> <code>{site}</code> <code>{duration}</code> <code>{resolution}</code> <code>{size}</code> <code>{url}</code> <code>{uploader}</code>\nCurrent: <code>${e(clip(current, 200))}</code>`,
  askEmbedTitle: "🧬 Send the title to write into the file's metadata (send - to clear).",
  askEmbedArtist: "🧬 Send the artist/creator to write into the metadata (send - to clear).",
  askDefaultCaption: "📝 Send the default caption (send - to restore the bot's default).",
  valueSaved: "✅ Saved.",
  inputCancelled: "↩️ Cancelled.",
  inputInvalid: (why) => `⚠️ ${e(why)}`,
  inputTooLong: (max) => `That text is too long (max ${max} characters).`,
  containerMenu: (note) => `📦 <b>Output container</b>\nThe bot only re-packages (no quality loss) whenever possible.${note ? `\n\n⚠️ ${e(note)}` : ""}`,
  containerLabels: { auto: "Automatic (MP4 when possible)", mp4: "MP4", webm: "WebM", mkv: "MKV", original: "Original (unchanged)", mp3: "MP3", m4a: "M4A" },
  containerNeedsTranscode: (name) => `${name} (needs re-encoding)`,
  transcodeToggle: (on) => `${on ? "✅" : "⬜️"} Allow re-encoding`,
  deliveryMenu: (limits) =>
    `🚚 <b>Delivery method</b>\n\n• <b>Automatic</b>: up to ${limits.cloud} via the Bot API, larger files over MTProto or as a download link.\n• <b>Direct Telegram</b>: only up to ${limits.cloud}.\n${limits.mtproto ? `• <b>MTProto</b>: up to ${limits.mtproto}, delivered directly in Telegram.\n` : ""}` +
    `${limits.local ? `• <b>Local server</b>: up to ${limits.local} (experimental).\n` : ""}• <b>Download link</b>: always a temporary signed link.`,
  deliveryLabels: { auto: "🤖 Automatic", bot_api_cloud: "📤 Direct Telegram", mtproto: "📡 Direct (up to 2 GB)", bot_api_local: "🏠 Local server", r2_link: "🔗 Download link" },
  startRejected: (why) => `⛔ Cannot start: ${e(why)}`,
  nothingSelected: "Pick a quality first.",
  started: "✅ Started…",

  statusQueued: "⏳ <b>Queued</b>\nIt starts as soon as capacity is free.",
  statusInspect: "🔎 <b>Checking the link...</b>",
  statusStarting: "🚀 <b>Starting the processing server...</b>",
  statusRetry: (attempt, max, sec) => `🔁 <b>Retrying</b>\nAttempt ${attempt} of ${max} in ${sec}s.`,
  statusProgress: (d: StatusData) => {
    const head = { downloading: "📥 <b>Download status</b>", processing: "⚙️ <b>Processing</b>", uploading: "📤 <b>Uploading</b>" }[d.phase];
    const phaseText = { downloading: d.detail === "video+audio" ? "Fetching video and audio" : "Fetching the file", processing: "Merging and verifying (FFmpeg)", uploading: "Sending to Telegram" }[d.phase];
    const lines = [head, `🎬 ${e(clip(d.title, 70))}`, `Quality: ${e(d.label)}`];
    if (d.percent !== null) lines.push(progressBar(d.percent), `Progress: ${Math.floor(d.percent)}%`);
    if (d.done !== null && d.total) lines.push(`Size: ${formatBytes(d.done)} of ${formatBytes(d.total)}`);
    const speed = formatSpeed(d.speed);
    if (speed) lines.push(`Speed: ${speed}`);
    if (d.eta) lines.push(`Time left: ${formatDuration(d.eta)}`);
    lines.push(`Status: ${phaseText}`);
    return lines.join("\n");
  },
  statusCompleted: (title, label, size) => `✅ <b>Done</b>\n🎬 ${e(clip(title, 80))}\n${e(label)} · ${formatBytes(size)}`,
  statusFailed: (code, detail) => `❌ <b>Failed</b>\n\n${errorTexts[code]}${detail ? `\n<i>${e(clip(detail, 300))}</i>` : ""}`,
  statusCancelled: "🚫 <b>Cancelled.</b>",
  statusExpired: "⌛ This request expired.",
  cancelledAlert: "Cancelled.",
  nothingToCancel: "You have no active download to cancel.",
  cancelledCount: (n) => `🚫 Cancelled ${n} item(s).`,
  linkReady: (title, label, size, url, expires, reason) =>
    `✅ <b>File ready</b>\n🎬 ${e(clip(title, 80))}\n${e(label)} · ${formatBytes(size)}\n\n` +
    `${reason === "size" ? "Because the file is larger than Telegram's direct-send limit" : "As you chose"}, a temporary signed download link was created:\n` +
    `🔗 <a href="${e(url)}">Download file</a>\n⏳ Valid until ${e(expires)}, then deleted.`,

  historyHeader: (page, pages, total) => `📂 <b>Download history</b> (${total} items · page ${page} of ${pages})`,
  historyEmpty: "📂 You have no downloads yet.",
  historyLine: (n, site, label, status, title) => `${n}. ${status} ${e(clip(title ?? "—", 40))} · ${e(site ?? "—")}${label ? ` · ${e(label)}` : ""}`,
  statusIcons: { queued: "⏳", inspecting: "🔎", ready: "🟦", downloading: "📥", processing: "⚙️", uploading: "📤", completed: "✅", failed: "❌", cancelled: "🚫", retry_wait: "🔁", expired: "⌛" },
  historyDetail: (d) =>
    `🧾 <b>Download details</b>\n\nID: <code>${e(d.id)}</code>\nTitle: ${e(clip(d.title ?? "—", 90))}\nSource: ${e(d.site ?? "—")}\nQuality: ${e(d.label ?? "—")}\n` +
    `Status: ${d.status}\nStarted: ${e(d.created)}\nFinished: ${e(d.finished ?? "—")}\nDelivery: ${e(d.delivery ?? "—")}${d.size ? ` · ${formatBytes(d.size)}` : ""}\n${d.error ? `Error category: <code>${e(d.error)}</code>\n` : ""}Link: ${e(clip(d.url, 120))}`,
  btnClearHistory: "🗑 Clear history",
  confirmClear: "⚠️ Are you sure? All your finished download history will be deleted.",
  btnConfirmYes: "✅ Yes, clear it",
  historyCleared: (n) => `🗑 Cleared ${n} item(s).`,
  btnPrev: "◀️ Prev",
  btnNext: "Next ▶️",
  accountText: (d) =>
    `👤 <b>My account</b>\n\nID: <code>${d.id}</code>\n${d.username ? `Username: @${e(d.username)}\n` : ""}Member since: ${e(d.since)}\nTotal downloads: ${d.total}\nActive now: ${d.active} of ${d.limits.perUser}\nToday: ${d.today}\nRate limit: ${d.limits.perMinute} per minute`,
  settingsTitle: "⚙️ <b>Settings</b>\nTap an item to change it:",
  settingLabels: {
    resolution: (v) => `📺 Default quality: ${v === "ask" ? "ask every time" : v === "best" ? "best" : `${v}p`}`,
    container: (v) => `📦 Default container: ${{ auto: "automatic", mp4: "MP4", webm: "WebM", original: "original" }[v] ?? v}`,
    quickStart: (v) => `${v ? "✅" : "⬜️"} Start right after picking a quality`,
    thumbnail: (v) => `🖼 Cover: ${{ original: "original", frame: "video frame", none: "none" }[v] ?? v}`,
    delivery: (v) => `🚚 Delivery: ${{ auto: "automatic", bot_api_cloud: "direct Telegram", mtproto: "direct (up to 2 GB)", bot_api_local: "local server", r2_link: "download link" }[v] ?? v}`,
    sendAs: (v) => `🎞 Send as: ${v === "document" ? "file" : "automatic"}`,
    caption: (v) => `📝 Default caption: ${v ? "custom" : "bot default"}`,
    progress: (v) => `${v ? "✅" : "⬜️"} Show progress`,
    embed: (v) => `${v ? "✅" : "⬜️"} Write title into file metadata`,
    language: "🌐 Language: English",
  },

  adminOnly: "⛔ This command is for administrators only.",
  adminHelp:
    `<b>Admin panel</b>\n\n/admin stats\n/admin active\n/admin failed\n/admin health\n/admin limits\n/admin set &lt;key&gt; &lt;value&gt;\n/admin reset &lt;key&gt;\n` +
    `/admin block &lt;user_id&gt; [reason] · /admin unblock &lt;user_id&gt; · /admin blocked\n/admin cleanup\n/admin maintenance on|off\n/admin announce &lt;text&gt;`,
};

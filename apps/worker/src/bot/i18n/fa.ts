import type { DeliveryMode, ErrorCode } from "@tvd/shared-types";
import { clip, escapeHtml as e, formatBytes, formatDuration, formatSpeed, progressBar, RLM, toFa } from "../format";

export interface MenuLine {
  label: string;
  size: number | null;
  approx: boolean;
  badge: "direct" | "link" | "rejected";
}
export interface MenuData {
  title: string;
  site: string;
  duration: number | null;
  uploader: string | null;
  uploadDate: string | null;
  lines: MenuLine[];
  hasAudio: boolean;
}
export interface CustomizeData {
  label: string;
  title: string;
  filename: string;
  caption: string;
  container: string;
  thumbnail: "original" | "frame" | "custom" | "none";
  delivery: DeliveryMode;
  badge: "direct" | "link" | "rejected";
  sendAs: "auto" | "video" | "document";
  embedTitle: string | null;
  embedArtist: string | null;
  estimatedBytes: number | null;
  transcode: boolean;
}
export interface StatusData {
  title: string;
  label: string;
  percent: number | null;
  speed: number | null;
  eta: number | null;
  done: number | null;
  total: number | null;
  detail: string | null;
  phase: "downloading" | "processing" | "uploading";
}

const BADGE = { direct: "📤", link: "🔗", rejected: "🚫" } as const;
const LABELS = {
  download: "🎬 دانلود ویدیو",
  settings: "⚙️ تنظیمات",
  history: "📂 تاریخچه دانلودها",
  help: "❓ راهنما",
  account: "👤 حساب کاربری",
} as const;

const errorTexts: Record<ErrorCode, string> = {
  invalid_url: "❌ این لینک معتبر نیست. یه آدرس کامل که با http:// یا https:// شروع بشه بفرست.",
  blocked_url: "🚫 این آدرس مجاز نیست (آدرس‌های داخلی، لوکال یا غیرعمومی پردازش نمی‌شن).",
  unsupported_site: "❓ این سایت یا این نوع لینک پشتیبانی نمی‌شه، یا ویدیویی توش پیدا نشد.",
  private_video: "🔒 این ویدیو خصوصی یا فقط مخصوص اعضاست و بدون دسترسی قابل دانلود نیست.",
  login_required: "🔑 دیدن این محتوا نیاز به ورود به حساب (یا تأیید سن) داره. ربات رمز یا کوکی کاربران رو نمی‌گیره و محدودیت دسترسی رو دور نمی‌زنه.",
  geo_restricted: "🌍 این ویدیو از منطقه‌ی سرور ربات در دسترس نیست (محدودیت جغرافیایی).",
  unavailable: "🗑 ویدیو حذف شده، لینکش منقضی شده یا دیگه در دسترس نیست.",
  drm_protected: "🛡 این ویدیو با DRM محافظت شده و ربات اون رو دانلود نمی‌کنه.",
  rate_limited: "⏳ سایت مبدأ موقتاً درخواست‌ها رو محدود کرده. چند دقیقه‌ی دیگه دوباره امتحان کن.",
  bot_check: "🤖 سایت مبدأ درخواست رو به‌عنوان ربات تشخیص داد (تأیید «ربات نیستم» یا مسدود بودن IP سرورها). ربات این محافظت‌ها رو دور نمی‌زنه؛ با یه لینک دیگه یا بعداً امتحان کن.",
  network_error: "📡 اتصال به سایت مبدأ برقرار نشد یا وسط کار قطع شد.",
  too_large: "📦 حجم فایل از حد مجاز بیشتره.",
  too_long: "⏱ مدت این ویدیو از حد مجاز بیشتره.",
  format_unavailable: "🎞 فرمت انتخابی در دسترس نیست یا بدون تبدیل (کدگذاری مجدد) داخل کانتینر خواسته‌شده جا نمی‌شه.",
  ffmpeg_failed: "🛠 پردازش ویدیو (FFmpeg) با خطا مواجه شد.",
  validation_failed: "🧪 فایل خروجی بررسی نهایی رو رد نشد (ویدیو معیوب یا ناقص بود).",
  upload_failed: "📤 ارسال فایل به تلگرام ناموفق بود.",
  telegram_error: "✉️ تلگرام ارسال فایل رو رد کرد.",
  timeout: "⌛ زمان مجاز عملیات تموم شد.",
  cancelled: "🚫 عملیات لغو شد.",
  container_lost: "♻️ سرور پردازش وسط کار ری‌استارت شد.",
  disk_full: "💾 فضای موقت سرور پردازش کافی نبود.",
  internal: "⚠️ خطای داخلی رخ داد.",
};

export const fa = {
  lang: "fa" as "fa" | "en",
  labels: LABELS as Record<keyof typeof LABELS, string>,
  commands: [
    { command: "start", description: "شروع و منوی اصلی" },
    { command: "help", description: "راهنما" },
    { command: "settings", description: "تنظیمات" },
    { command: "history", description: "تاریخچه دانلودها" },
    { command: "cancel", description: "لغو دانلودهای فعال" },
    { command: "privacy", description: "حریم خصوصی" },
  ],

  welcome: (name: string | null) =>
    `${RLM}سلام${name ? ` ${e(name)}` : ""}! 👋\n\n` +
    `${RLM}لینک ویدیو رو از هر سایتی که پشتیبانی بشه همین‌جا بفرست؛ لازم نیست اول از منو چیزی انتخاب کنی.\n\n` +
    `${RLM}🔎 اطلاعات واقعی ویدیو رو درمیارم\n` +
    `${RLM}📺 کیفیت‌های موجود رو با حجم نشون می‌دم\n` +
    `${RLM}🖼 کاور، عنوان و کپشن رو می‌تونی شخصی‌سازی کنی\n` +
    `${RLM}📤 فایل نهایی رو بررسی و برات می‌فرستم`,
  help:
    `${RLM}<b>راهنما</b>\n\n` +
    `${RLM}1️⃣ لینک ویدیو رو بفرست.\n` +
    `${RLM}2️⃣ کیفیت دلخواه رو از بین گزینه‌های واقعی انتخاب کن.\n` +
    `${RLM}3️⃣ اگه خواستی با «✨ شخصی‌سازی» کاور، عنوان، نام فایل و کپشن رو عوض کن.\n` +
    `${RLM}4️⃣ پیشرفت دانلود رو همین‌جا می‌بینی و هر وقت خواستی لغو می‌کنی.\n\n` +
    `${RLM}📤 یعنی فایل مستقیم توی تلگرام فرستاده می‌شه؛ 🔗 یعنی چون حجمش از سقف ارسال تلگرام بیشتره، لینک دانلود موقت و امضاشده می‌گیری.\n\n` +
    `${RLM}<b>دستورها:</b> /settings تنظیمات · /history تاریخچه · /cancel لغو · /privacy حریم خصوصی\n\n` +
    `${RLM}⚠️ فقط محتوایی رو دانلود کن که اجازه‌ی دانلودش رو داری. محتوای DRM، خصوصی یا نیازمند ورود پشتیبانی نمی‌شه.`,
  privacy:
    `${RLM}<b>حریم خصوصی</b>\n\n` +
    `${RLM}• فقط شناسه‌ی تلگرام، تنظیمات و تاریخچه‌ی دانلودهات (لینک، کیفیت، نتیجه) نگه‌داری می‌شه.\n` +
    `${RLM}• فایل‌های ویدیو به‌صورت پیش‌فرض ذخیره نمی‌شن؛ بعد از ارسال حذف می‌شن. لینک‌های دانلود موقت بعد از مدت کوتاهی پاک می‌شن.\n` +
    `${RLM}• ربات هرگز رمز یا کوکی سایت‌ها رو نمی‌خواد.\n` +
    `${RLM}• با /history می‌تونی تاریخچه‌ات رو پاک کنی.`,
  sendLink: "🔗 لینک ویدیو رو همین‌جا بفرست.",
  unknownInput: "متوجه نشدم. یه لینک ویدیو بفرست یا از منوی پایین استفاده کن.",

  // ── intake ──
  inspecting: "🔎 در حال بررسی لینک و استخراج اطلاعات ویدیو...",
  invalidUrl: errorTexts.invalid_url,
  blockedUrl: (reason: string) => `${errorTexts.blocked_url}\n<i>${e(reason)}</i>`,
  rateLimited: (sec: number) => `⏳ درخواست‌هات زیاده. ${toFa(sec)} ثانیه‌ی دیگه دوباره امتحان کن.`,
  tooManyActive: (n: number) => `⚠️ همین الان ${toFa(n)} دانلود فعال داری. صبر کن یکی تموم بشه یا با /cancel لغوشون کن.`,
  queueFull: "🚦 سرور الان شلوغه و صف پر شده. چند دقیقه دیگه دوباره امتحان کن.",
  engineOffline: "🔌 موتور دانلود الان آفلاینه (روی کامپیوتر ادمین اجرا می‌شه). کمی بعد دوباره لینک رو بفرست.",
  alreadyProcessing: "♻️ همین لینک الان در حال پردازشه. نتیجه همین‌جا اعلام می‌شه.",
  blocked: (reason: string | null) => `⛔ دسترسی تو به این ربات مسدود شده.${reason ? `\n<i>${e(reason)}</i>` : ""}`,
  maintenance: "🛠 ربات موقتاً در حال نگه‌داری‌ست. کمی بعد دوباره امتحان کن.",
  notYourItem: "این مورد مال تو نیست.",
  jobNotFound: "این مورد پیدا نشد (احتمالاً قدیمی شده). لینک رو دوباره بفرست.",
  menuExpired: "⌛ این منو منقضی شده. لینک رو دوباره بفرست.",
  error: (code: ErrorCode, detail?: string | null) => `${errorTexts[code]}${detail ? `\n<i>${e(clip(detail, 300))}</i>` : ""}`,
  playlistPrompt: (title: string, count: number, shown: number) =>
    `${RLM}📚 <b>${e(clip(title || "لیست ویدیو", 120))}</b>\n${RLM}این لینک ${toFa(count)} ویدیو داره${count > shown ? ` (${toFa(shown)} مورد اول نمایش داده می‌شه)` : ""}. یکی رو انتخاب کن:`,

  // ── quality menu ──
  menuCaption: (d: MenuData) => {
    const meta = [`🌐 ${e(d.site)}`, d.duration ? `⏱ ${formatDuration(d.duration)}` : null, d.uploader ? `👤 ${e(clip(d.uploader, 40))}` : null]
      .filter(Boolean)
      .join(" · ");
    const lines = d.lines.slice(0, 14).map((l) => `• ${l.label}${l.size ? ` — ${l.approx ? "≈" : ""}${formatBytes(l.size)}` : ""} ${BADGE[l.badge]}`);
    return (
      `${RLM}🎬 <b>${e(clip(d.title, 180))}</b>\n${RLM}${meta}\n\n` +
      `${RLM}📺 <b>کیفیت‌های موجود:</b>\n${lines.join("\n")}${d.hasAudio ? "\n• 🎵 فقط صدا (MP3)" : ""}\n\n` +
      `${RLM}📤 ارسال مستقیم در تلگرام · 🔗 لینک دانلود · 🚫 بیش از حد مجاز\n` +
      `${RLM}👇 کیفیت دلخواهت رو انتخاب کن:`
    );
  },
  btnQuality: (label: string, size: number | null, approx: boolean, badge: MenuLine["badge"]) =>
    `${badge === "rejected" ? "🚫" : "🎬"} ${label}${size ? ` · ${approx ? "≈" : ""}${formatBytes(size)}` : ""}${badge === "rejected" ? "" : ` ${BADGE[badge]}`}`,
  btnBest: "⭐ بهترین کیفیت",
  btnAudio: (size: number | null) => `🎵 فقط صدا (MP3)${size ? ` · ≈${formatBytes(size)}` : ""}`,
  btnAdvanced: "🎛 فرمت‌های پیشرفته",
  btnAudioTracks: "🌐 زبان صدا",
  btnCustomize: "✨ شخصی‌سازی",
  btnCancel: "❌ لغو",
  btnBack: "🔙 بازگشت",
  btnStart: "▶️ شروع دانلود",
  btnClose: "✖️ بستن",
  btnRetry: "🔁 تلاش دوباره",
  btnDownloadLink: "⬇️ دانلود فایل",
  rejectedAlert: (why: string) => `این گزینه قابل ارسال نیست: ${why}. گزینه‌ی دیگه‌ای انتخاب کن یا روش تحویل رو در «شخصی‌سازی» عوض کن.`,
  advancedTitle: (page: number, pages: number) => `${RLM}🎛 <b>فرمت‌های پیشرفته</b> (صفحه‌ی ${toFa(page)} از ${toFa(pages)})\n${RLM}رزولوشن، نرخ فریم، کدک و محدوده‌ی رنگ واقعی هر فرمت:`,
  audioTracksTitle: `${RLM}🌐 <b>زبان صدا</b>\n${RLM}صداهای موجود برای این ویدیو:`,

  // ── customize ──
  customizeText: (d: CustomizeData) =>
    `${RLM}✨ <b>شخصی‌سازی</b>\n\n` +
    `${RLM}📺 انتخاب‌شده: <b>${e(d.label)}</b>${d.estimatedBytes ? ` · ≈${formatBytes(d.estimatedBytes)}` : ""}\n` +
    `${RLM}🏷 عنوان نمایشی: ${e(clip(d.title, 80))}\n` +
    `${RLM}📁 نام فایل: <code>${e(clip(d.filename, 80))}</code>\n` +
    `${RLM}📝 کپشن: ${e(clip(d.caption.replace(/\{[a-z]+\}/g, "…"), 80))}\n` +
    `${RLM}🧬 متادیتای داخل فایل: ${d.embedTitle || d.embedArtist ? `${e(d.embedTitle ?? "—")} / ${e(d.embedArtist ?? "—")}` : "بدون تغییر"}\n` +
    `${RLM}🖼 کاور: ${{ original: "اصلی ویدیو", frame: "فریمی از ویدیو", custom: "تصویر دلخواه", none: "بدون کاور" }[d.thumbnail]}\n` +
    `${RLM}📦 فرمت خروجی: ${e(d.container)}${d.transcode ? " (با تبدیل)" : ""}\n` +
    `${RLM}🚚 روش تحویل: ${{ bot_api_cloud: "مستقیم در تلگرام", bot_api_local: "مستقیم (سرور لوکال)", mtproto: "مستقیم در تلگرام (تا ۲ گیگ)", r2_link: "لینک دانلود" }[d.delivery]} ${BADGE[d.badge]}\n` +
    `${RLM}🎞 نوع ارسال: ${{ auto: "خودکار", video: "ویدیو", document: "فایل" }[d.sendAs]}`,
  btnThumbnail: "🖼 کاور",
  btnTitle: "🏷 عنوان",
  btnFilename: "📁 نام فایل",
  btnCaption: "📝 کپشن",
  btnMetadata: "🧬 متادیتا",
  btnContainer: "📦 فرمت",
  btnDelivery: "🚚 روش تحویل",
  btnSendAs: (v: string) => `🎞 ارسال به‌صورت: ${v === "document" ? "فایل" : v === "video" ? "ویدیو" : "خودکار"}`,
  thumbMenu: `${RLM}🖼 <b>کاور (thumbnail)</b>\n${RLM}کاور باید JPEG زیر ۲۰۰ کیلوبایت و حداکثر ۳۲۰ پیکسل باشه؛ ربات تصویر تو رو خودش تبدیل می‌کنه.`,
  thumbOptions: { original: "🖼 کاور اصلی", frame: "🎞 فریمی از ویدیو", preview: "👁 پیش‌نمایش چند فریم", upload: "📤 آپلود تصویر دلخواه", none: "🚫 بدون کاور" },
  thumbSet: (mode: string) => `✅ کاور روی «${mode}» تنظیم شد.`,
  framesLoading: "🎞 در حال استخراج چند فریم از ویدیو...",
  framesCaption: (i: number, t: number) => `${RLM}فریم ${toFa(i)} · ${formatDuration(t)}`,
  framesPick: `${RLM}کدوم فریم به‌عنوان کاور باشه؟`,
  framesFailed: (why: string) => `⚠️ پیش‌نمایش فریم‌ها ممکن نشد (${e(why)}). می‌تونی «فریمی از ویدیو» رو انتخاب کنی؛ بعد از دانلود ساخته می‌شه.`,
  askThumbnail: "🖼 تصویر دلخواهت رو به‌صورت عکس بفرست (برای /cancel کردن، دستور /cancel رو بزن).",
  askTitle: (current: string) => `🏷 عنوان نمایشی جدید رو بفرست.\nفعلی: <code>${e(clip(current, 100))}</code>`,
  askFilename: (current: string) => `📁 نام فایل جدید رو بفرست (بدون پسوند؛ پسوند خودکار اضافه می‌شه).\nفعلی: <code>${e(clip(current, 100))}</code>`,
  askCaption: (current: string) =>
    `📝 کپشن جدید رو بفرست (حداکثر ۹۰۰ کاراکتر).\nجاگذاری‌های خودکار: <code>{title}</code> <code>{site}</code> <code>{duration}</code> <code>{resolution}</code> <code>{size}</code> <code>{url}</code> <code>{uploader}</code>\nفعلی: <code>${e(clip(current, 200))}</code>`,
  askEmbedTitle: "🧬 عنوانی که داخل متادیتای فایل نوشته بشه رو بفرست (برای حذف: -).",
  askEmbedArtist: "🧬 نام هنرمند/سازنده‌ی داخل متادیتا رو بفرست (برای حذف: -).",
  askDefaultCaption: "📝 کپشن پیش‌فرض رو بفرست (برای بازگشت به حالت عادی: -).",
  valueSaved: "✅ ذخیره شد.",
  inputCancelled: "↩️ انصراف داده شد.",
  inputInvalid: (why: string) => `⚠️ ${e(why)}`,
  inputTooLong: (max: number) => `متن خیلی بلنده (حداکثر ${toFa(max)} کاراکتر).`,
  containerMenu: (note: string | null) => `${RLM}📦 <b>فرمت خروجی</b>\n${RLM}ربات تا جای ممکن فقط بسته‌بندی مجدد می‌کنه (بدون افت کیفیت).${note ? `\n\n⚠️ ${e(note)}` : ""}`,
  containerLabels: { auto: "خودکار (MP4 اگه ممکن باشه)", mp4: "MP4", webm: "WebM", mkv: "MKV", original: "اصلی (بدون تغییر)", mp3: "MP3", m4a: "M4A" } as Record<string, string>,
  containerNeedsTranscode: (name: string) => `${name} (نیاز به تبدیل دارد)`,
  transcodeToggle: (on: boolean) => `${on ? "✅" : "⬜️"} اجازه‌ی تبدیل (کدگذاری مجدد)`,
  deliveryMenu: (limits: { cloud: string; mtproto: string | null; local: string | null }) =>
    `${RLM}🚚 <b>روش تحویل فایل</b>\n\n` +
    `${RLM}• <b>خودکار</b>: تا ${limits.cloud} مستقیم در تلگرام، بیشتر از اون لینک دانلود.\n` +
    `${RLM}• <b>مستقیم تلگرام</b>: فقط تا ${limits.cloud}.\n` +
    `${RLM}${limits.mtproto ? `• <b>مستقیم تا ${limits.mtproto}</b> (MTProto): فایل بزرگ هم مستقیم توی تلگرام می‌آد.\n` : ""}` +
    `${RLM}${limits.local ? `• <b>سرور لوکال</b>: تا ${limits.local} (آزمایشی).\n` : ""}` +
    `${RLM}• <b>لینک دانلود</b>: همیشه لینک موقت و امضاشده.`,
  deliveryLabels: { auto: "🤖 خودکار", bot_api_cloud: "📤 مستقیم تلگرام", mtproto: "📡 مستقیم (تا ۲ گیگ)", bot_api_local: "🏠 سرور لوکال", r2_link: "🔗 لینک دانلود" } as Record<string, string>,
  startRejected: (why: string) => `⛔ نمی‌شه شروع کرد: ${e(why)}`,
  nothingSelected: "اول یه کیفیت انتخاب کن.",
  started: "✅ شروع شد…",

  // ── status / progress ──
  statusQueued: "⏳ <b>در صف پردازش</b>\nبه محض آزاد شدن ظرفیت شروع می‌شه.",
  statusInspect: "🔎 <b>در حال بررسی لینک...</b>",
  statusStarting: "🚀 <b>در حال آماده‌سازی سرور پردازش...</b>",
  statusRetry: (attempt: number, max: number, sec: number) => `🔁 <b>تلاش دوباره</b>\nتلاش ${toFa(attempt)} از ${toFa(max)} تا ${toFa(sec)} ثانیه‌ی دیگه.`,
  statusProgress: (d: StatusData) => {
    const head = { downloading: "📥 <b>وضعیت دانلود</b>", processing: "⚙️ <b>در حال پردازش</b>", uploading: "📤 <b>در حال ارسال</b>" }[d.phase];
    const phaseText = { downloading: d.detail === "video+audio" ? "دریافت ویدیو و صدا" : "دریافت فایل", processing: "ادغام و بررسی فایل (FFmpeg)", uploading: "ارسال به تلگرام" }[d.phase];
    const lines = [`${RLM}${head}`, `${RLM}🎬 ${e(clip(d.title, 70))}`, `${RLM}کیفیت: ${e(d.label)}`];
    if (d.percent !== null) lines.push(`${RLM}${progressBar(d.percent)}`, `${RLM}پیشرفت: ${toFa(Math.floor(d.percent))}٪`);
    if (d.done !== null && d.total) lines.push(`${RLM}حجم: ${formatBytes(d.done)} از ${formatBytes(d.total)}`);
    const speed = formatSpeed(d.speed);
    if (speed) lines.push(`${RLM}سرعت: ${speed}`);
    if (d.eta) lines.push(`${RLM}زمان باقی‌مانده: ${formatDuration(d.eta)}`);
    lines.push(`${RLM}وضعیت: ${phaseText}`);
    return lines.join("\n");
  },
  statusCompleted: (title: string, label: string, size: number) => `${RLM}✅ <b>تکمیل شد</b>\n${RLM}🎬 ${e(clip(title, 80))}\n${RLM}${e(label)} · ${formatBytes(size)}`,
  statusFailed: (code: ErrorCode, detail: string | null) => `${RLM}❌ <b>ناموفق</b>\n\n${errorTexts[code]}${detail ? `\n<i>${e(clip(detail, 300))}</i>` : ""}`,
  statusCancelled: "🚫 <b>لغو شد.</b>",
  statusExpired: "⌛ این درخواست منقضی شد.",
  cancelledAlert: "لغو شد.",
  nothingToCancel: "دانلود فعالی برای لغو نداری.",
  cancelledCount: (n: number) => `🚫 ${toFa(n)} مورد لغو شد.`,
  linkReady: (title: string, label: string, size: number, url: string, expires: string, reason: "size" | "choice") =>
    `${RLM}✅ <b>فایل آماده شد</b>\n${RLM}🎬 ${e(clip(title, 80))}\n${RLM}${e(label)} · ${formatBytes(size)}\n\n` +
    `${RLM}${reason === "size" ? "چون حجم فایل از سقف ارسال مستقیم تلگرام بیشتره" : "طبق انتخاب تو"}، یه لینک دانلود امضاشده و موقت ساخته شد:\n` +
    `${RLM}🔗 <a href="${e(url)}">دانلود فایل</a>\n${RLM}⏳ تا ${e(expires)} معتبره و بعد از اون پاک می‌شه.`,

  // ── history / account / settings ──
  historyHeader: (page: number, pages: number, total: number) => `${RLM}📂 <b>تاریخچه دانلودها</b> (${toFa(total)} مورد · صفحه‌ی ${toFa(page)} از ${toFa(pages)})`,
  historyEmpty: "📂 هنوز دانلودی نداشتی.",
  historyLine: (n: number, site: string | null, label: string | null, status: string, title: string | null) =>
    `${toFa(n)}. ${status} ${e(clip(title ?? "—", 40))} · ${e(site ?? "—")}${label ? ` · ${e(label)}` : ""}`,
  statusIcons: { queued: "⏳", inspecting: "🔎", ready: "🟦", downloading: "📥", processing: "⚙️", uploading: "📤", completed: "✅", failed: "❌", cancelled: "🚫", retry_wait: "🔁", expired: "⌛" } as Record<string, string>,
  historyDetail: (d: { id: string; site: string | null; title: string | null; label: string | null; status: string; created: string; finished: string | null; delivery: string | null; size: number | null; error: string | null; url: string }) =>
    `${RLM}🧾 <b>جزئیات دانلود</b>\n\n` +
    `${RLM}شناسه: <code>${e(d.id)}</code>\n${RLM}عنوان: ${e(clip(d.title ?? "—", 90))}\n${RLM}منبع: ${e(d.site ?? "—")}\n${RLM}کیفیت: ${e(d.label ?? "—")}\n` +
    `${RLM}وضعیت: ${d.status}\n${RLM}شروع: ${e(d.created)}\n${RLM}پایان: ${e(d.finished ?? "—")}\n` +
    `${RLM}تحویل: ${e(d.delivery ?? "—")}${d.size ? ` · ${formatBytes(d.size)}` : ""}\n${d.error ? `${RLM}دسته‌ی خطا: <code>${e(d.error)}</code>\n` : ""}${RLM}لینک: ${e(clip(d.url, 120))}`,
  btnClearHistory: "🗑 پاک کردن تاریخچه",
  confirmClear: "⚠️ مطمئنی؟ همه‌ی تاریخچه‌ی دانلودهای تموم‌شده‌ات پاک می‌شه.",
  btnConfirmYes: "✅ بله، پاک کن",
  historyCleared: (n: number) => `🗑 ${toFa(n)} مورد پاک شد.`,
  btnPrev: "◀️ قبلی",
  btnNext: "بعدی ▶️",
  accountText: (d: { id: number; username: string | null; total: number; active: number; today: number; limits: { perUser: number; perMinute: number }; since: string }) =>
    `${RLM}👤 <b>حساب کاربری</b>\n\n${RLM}شناسه: <code>${d.id}</code>\n${d.username ? `${RLM}نام کاربری: @${e(d.username)}\n` : ""}` +
    `${RLM}عضویت: ${e(d.since)}\n${RLM}کل دانلودها: ${toFa(d.total)}\n${RLM}فعال الان: ${toFa(d.active)} از ${toFa(d.limits.perUser)}\n${RLM}امروز: ${toFa(d.today)}\n${RLM}محدودیت درخواست: ${toFa(d.limits.perMinute)} در دقیقه`,
  settingsTitle: `${RLM}⚙️ <b>تنظیمات</b>\n${RLM}روی هر مورد بزن تا تغییر کنه:`,
  settingLabels: {
    resolution: (v: string) => `📺 کیفیت پیش‌فرض: ${v === "ask" ? "هر بار بپرس" : v === "best" ? "بهترین" : `${v}p`}`,
    container: (v: string) => `📦 فرمت پیش‌فرض: ${{ auto: "خودکار", mp4: "MP4", webm: "WebM", original: "اصلی" }[v] ?? v}`,
    quickStart: (v: boolean) => `${v ? "✅" : "⬜️"} شروع فوری بعد از انتخاب کیفیت`,
    thumbnail: (v: string) => `🖼 کاور: ${{ original: "اصلی", frame: "فریم ویدیو", none: "بدون کاور" }[v] ?? v}`,
    delivery: (v: string) => `🚚 روش تحویل: ${{ auto: "خودکار", bot_api_cloud: "مستقیم تلگرام", mtproto: "مستقیم (تا ۲ گیگ)", bot_api_local: "سرور لوکال", r2_link: "لینک دانلود" }[v] ?? v}`,
    sendAs: (v: string) => `🎞 ارسال به‌صورت: ${v === "document" ? "فایل" : "خودکار"}`,
    caption: (v: string | null) => `📝 کپشن پیش‌فرض: ${v ? "سفارشی" : "پیش‌فرض ربات"}`,
    progress: (v: boolean) => `${v ? "✅" : "⬜️"} نمایش پیشرفت`,
    embed: (v: boolean) => `${v ? "✅" : "⬜️"} نوشتن عنوان در متادیتای فایل`,
    language: "🌐 زبان: فارسی",
  },

  // ── admin ──
  adminOnly: "⛔ این دستور فقط برای ادمین‌هاست.",
  adminHelp:
    `<b>پنل ادمین</b>\n\n/admin stats — آمار\n/admin active — کارهای فعال\n/admin failed — کارهای ناموفق اخیر\n/admin health — سلامت صف، کانتینر و دیتابیس\n` +
    `/admin limits — محدودیت‌های فعلی\n/admin set &lt;key&gt; &lt;value&gt; — تغییر محدودیت\n/admin reset &lt;key&gt; — برگشت به پیش‌فرض\n` +
    `/admin block &lt;user_id&gt; [دلیل] · /admin unblock &lt;user_id&gt; · /admin blocked\n/admin cleanup — پاک‌سازی دستی\n` +
    `/admin maintenance on|off\n/admin announce &lt;متن&gt; — اعلان به همه (با تأیید)`,
};

export type Messages = typeof fa;

<div align="center">

# ربات دانلود ویدیو برای تلگرام

**لینک را بفرست، کیفیتِ واقعی را انتخاب کن، ویدیوی بررسی‌شده را داخل تلگرام بگیر — تا حدود ۲ گیگابایت.**

رباتی برای تلگرام که از هزاران سایت ویدیو و صدا دانلود می‌کند، فقط کیفیت‌هایی را نشان می‌دهد که منبع واقعاً دارد،
به تو اجازه می‌دهد کاور، عنوان، نام فایل و کپشن را شخصی‌سازی کنی و فایلِ کنترل‌شده را مستقیماً داخل چت می‌فرستد.

[English](README.md) · [فارسی](README.fa.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)
![Python ≥ 3.11](https://img.shields.io/badge/python-%E2%89%A5%203.11-3776AB?logo=python&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)

</div>

<div dir="rtl">

---

## ویژگی‌ها

- **فقط لینک را بفرست.** ربات مستقیم لینک را می‌پذیرد: یوتیوب و بیش از ۱۰۰۰ سایتی که [yt-dlp](https://github.com/yt-dlp/yt-dlp) پشتیبانی می‌کند، به‌علاوه‌ی لینک‌های مستقیم MP4/WebM/HLS/DASH.
- **فقط کیفیت‌های واقعی.** برای هر رزولوشنی که منبع واقعاً دارد یک دکمه نمایش داده می‌شود، همراه با حجم تخمینی یا دقیق و نشانی که می‌گوید فایل چگونه تحویل داده می‌شود. منوی پیشرفته همه‌ی فرمت‌ها (کدک، fps، HDR، کانتینر) و زبان‌های صدا را فهرست می‌کند و دریافت فقط صدا (MP3) هم یک لمس فاصله دارد.
- **فایل‌های بزرگ.** تا ۵۰ مگابایت با Bot API و تا حدود ۲ گیگابایت با MTProto (کتابخانه‌ی Telethon) — بدون تکه‌تکه‌کردن فایل و بدون میزبان واسطه.
- **همه‌چیز قابل شخصی‌سازی.** کاور (اصلی، یک فریم از خود ویدیو، پیش‌نمایش چند فریم، عکس خودت یا بدون کاور)، عنوان، نام فایل، کپشن و متادیتای جاسازی‌شده چهار تنظیم مستقل‌اند.
- **خروجی تأییدشده.** هر فایل پیش از ارسال با FFprobe بررسی می‌شود (کانتینر، استریم‌ها، مدت، رزولوشن). کیفیت هرگز بی‌صدا عوض نمی‌شود: اگر فرمت انتخابی ناپدید شود، کار با دلیل روشن ناموفق می‌شود.
- **رابط فارسی و انگلیسی**، پیشرفت زنده (درصد، سرعت، زمان باقی‌مانده، مرحله)، لغو در هر لحظه، تنظیمات و تاریخچه‌ی هر کاربر.
- **طراحی‌شده برای بازیابی.** ماشین حالتِ compare-and-set در D1، صف همراه با dead-letter queue، جاروکِ هر دقیقه و پردازش idempotent وب‌هوک — کالبک گم‌شده، پیام دوباره‌تحویل‌شده یا راه‌اندازی مجدد باعث تکرار یا از دست رفتن کار نمی‌شود.
- **امنیت در اولویت.** محافظت SSRF در چهار لایه، کالبک امضاشده برای هر کار، مقایسه‌ی ثابت‌زمان رمزها، لاگ‌های پاک‌سازی‌شده، محدودیت نرخ و سهمیه. جزئیات در [`docs/security.md`](docs/security.md).

## چگونه کار می‌کند

</div>

```
 Telegram ──webhook──►  Cloudflare Worker  (bot UI, state machine, queue, cron sweeper)
                          │  D1 · Queues
                          │            ▲  signed progress / result callbacks
                          ▼            │
                     Media engine ─────┘   yt-dlp → FFmpeg/FFprobe → thumbnails → upload
                     (Python, FastAPI)                         │
                                                               ▼
                                                  Telegram (Bot API ≤ 50 MB · MTProto ≤ ~2 GB)
```

<div dir="rtl">

Worker فقط نقش «مرکز کنترل» را دارد و هرگز چیزی دانلود یا تبدیل نمی‌کند. کار سنگین را موتور رسانه (media engine) انجام می‌دهد و با کالبک امضاشده گزارش می‌دهد.
این همان کد است که در دو پروفایل استقرار اجرا می‌شود:

| پروفایل | Worker | موتور رسانه | فایل‌های بزرگ | پیش‌نیاز |
|---|---|---|---|---|
| **رایگان** *(پیش‌فرض اسکریپت‌ها)* | Cloudflare Workers پلن **Free** | روی **کامپیوتر خودت**، از طریق تونل رایگان Cloudflare در دسترس | MTProto، تا حدود ۲ گیگابایت | `api_id` و `api_hash` تلگرام، `cloudflared`، FFmpeg — [`docs/free-plan-hybrid.md`](docs/free-plan-hybrid.md) |
| **پولی** *(`--paid`)* | Workers Paid | **Cloudflare Containers**، یک کانتینر برای هر کار | MTProto و/یا لینک دانلود روی R2 | Workers Paid، R2، Docker یا Workers Builds |

## روش‌های تحویل

| روش | سقف | توضیح |
|---|---|---|
| Bot API (`bot_api_cloud`) | ۵۰٬۰۰۰٬۰۰۰ بایت | برای فایل‌های کوچک خودکار انتخاب می‌شود |
| **MTProto** (`mtproto`) | ۲٬۰۰۰٬۰۰۰٬۰۰۰ بایت (سقف قابل تنظیم، پیش‌فرض ۱٫۹ گیگ) | خودِ حساب ربات با Telethon آپلود می‌کند؛ `api_id`/`api_hash` باید روی موتور باشد |
| لینک R2 (`r2_link`) | `MAX_OUTPUT_BYTES` | فقط پروفایل پولی: لینک دانلود امضاشده و موقت |
| سرور محلی Bot API (`bot_api_local`) | ۲٬۰۰۰٬۰۰۰٬۰۰۰ بایت | آزمایشی و به‌طور پیش‌فرض خاموش — [`docs/large-file-delivery.md`](docs/large-file-delivery.md) |

در حالت `auto` کوچک‌ترین روشی که فایل را حمل کند **پیش از دانلود** انتخاب می‌شود؛ فایلی که قابل تحویل نباشد از همان ابتدا رد می‌شود، نه در انتهای کار.

## شروع سریع (پروفایل رایگان)

**پیش‌نیازها:** Node.js نسخه‌ی ۲۲ یا بالاتر، Python نسخه‌ی ۳٫۱۱ یا بالاتر، FFmpeg و FFprobe در `PATH`، یک حساب Cloudflare (پلن Free)، توکن ربات از [@BotFather](https://t.me/BotFather) و یک جفت `api_id`/`api_hash` از <https://my.telegram.org>
(فقط برای فایل‌های بالای ۵۰ مگابایت لازم است). فایل رسمی [`cloudflared`](https://github.com/cloudflare/cloudflared/releases) را داخل پوشه‌ی `tools/` بگذار (روی ویندوز `tools/cloudflared.exe`).

</div>

```bash
git clone https://github.com/Parsairom/telegram-video-downloader.git
cd telegram-video-downloader

npm install
python -m venv .venv
.venv/bin/pip install -r apps/media-container/requirements.lock      # Windows: .venv\Scripts\pip

cp .env.example .env              # BOT_TOKEN, CLOUDFLARE_ACCOUNT_ID, TELEGRAM_API_ID, TELEGRAM_API_HASH را پر کن
npx wrangler login                # فقط یک بار

npm run provision                 # پایگاه‌داده‌ی D1 و صف‌ها را می‌سازد و migrationها را اعمال می‌کند
node scripts/discover-admin.mjs --write   # اختیاری: اول یک پیام به ربات بفرست؛ شناسه‌ی تلگرامت را به‌عنوان ادمین ذخیره می‌کند
npm run deploy                    # تست‌ها ← استقرار ← تنظیم PUBLIC_BASE_URL ← ثبت وب‌هوک تلگرام
npm run engine                    # تونل و موتور رسانه را راه می‌اندازد؛ این پنجره باز بماند
```

<div dir="rtl">

ربات را در تلگرام باز کن، `/start` بفرست و یک لینک بده. هر کاربر باید یک بار — در حالی که موتور روشن است — به ربات پیام بدهد تا بتوان فایل‌های بزرگ را با MTProto برایش فرستاد.
کار روزمره، عیب‌یابی و محدودیت‌های پروفایل رایگان در [`docs/free-plan-hybrid.md`](docs/free-plan-hybrid.md) و [`docs/operations.md`](docs/operations.md) آمده است.

**دستورهای ربات:** `/start` `/help` `/settings` `/history` `/cancel` `/privacy`؛ ادمین‌ها دستور `/admin` را هم دارند (آمار، کارهای فعال و ناموفق، سلامت سیستم، محدودیت‌ها، مسدودسازی کاربر، اعلان همگانی).

## پیکربندی

رمزها در `.env` (که git آن را نادیده می‌گیرد) نگهداری و با `npm run deploy` بارگذاری می‌شوند؛ تنظیمات عددی بخش `vars` در `apps/worker/wrangler.free.jsonc` هستند (برای پروفایل پولی `wrangler.jsonc`).
دستور `npm run provision` شناسه‌ی منابع تو را در فایل `wrangler.*.local.jsonc` می‌نویسد که git آن را نادیده می‌گیرد؛ پس قالب‌های داخل مخزن هیچ مقدار مربوط به حساب تو را ندارند.

| متغیر | پیش‌فرض | معنی |
|---|---|---|
| `MAX_OUTPUT_BYTES` | `1900000000` | سقف حجم هر فایل خروجی، به بایت |
| `MAX_CONCURRENT_JOBS` / `MAX_JOBS_PER_USER` | `2` / `2` | هم‌زمانیِ کل و هم‌زمانیِ هر کاربر |
| `TELEGRAM_DELIVERY_MODE` | `auto` | `auto`، `bot_api_cloud`، `mtproto`، `r2_link`، `bot_api_local` |
| `RATE_LIMIT_PER_MINUTE` | `6` | تعداد لینک مجاز هر کاربر در دقیقه |
| `UPSTREAM_PROXY`، `TELEGRAM_PROXY` | – | پروکسی موتور، وقتی سایت‌ها یا تلگرام در شبکه‌ی آن مسدودند |

فهرست کامل در [`docs/operations.md`](docs/operations.md) است.

## ساختار مخزن

</div>

```
apps/worker/            Cloudflare Worker (TypeScript): webhook, bot UI, D1, Queues, engine/container control, cron sweeper
  migrations/           D1 schema
  wrangler.free.jsonc   free profile template        wrangler.jsonc   paid profile template
apps/media-container/   Python media engine: policy proxy, yt-dlp, FFmpeg, thumbnails, Bot API + MTProto delivery (+ Dockerfile, tests)
packages/shared-types/  state machine, error codes and the Worker ↔ engine wire contract
scripts/                provision · secrets · deploy · webhook · discover-admin · run-engine · lock-deps
docs/                   architecture, security, operations, large files, free profile, adapters, dependency updates, test report
```

<div dir="rtl">

## توسعه و تست

</div>

```bash
.venv/bin/pip install pytest pytest-asyncio python-multipart ruff     # ابزار تست (ویندوز: .venv\Scripts\pip)، سپس venv را فعال کن

npm run test:all          # typecheck + lint + تست‌های Worker (workerd با migrationهای واقعی D1) + تست‌های موتور
npm test                  # فقط تست‌های Worker
npm run test:container    # تست‌های موتور — TVD_NO_AUTOAPP=1 را تنظیم کن و ffmpeg/ffprobe در PATH باشد
```

<div dir="rtl">

اینکه چه چیزی تأیید شده و چه چیزی نشده، همراه با مدرک، در [`docs/test-report.md`](docs/test-report.md) ثبت شده است.

## سایت‌های پشتیبانی‌شده و محدودیت‌ها

پشتیبانی از هر سایت دقیقاً به اندازه‌ی extractor مربوط در yt-dlp در همان روز است؛ اگر منبعی پردازش نشود ربات دلیلش را می‌گوید (پشتیبانی‌نشده، خصوصی، نیازمند ورود، محدودیت جغرافیایی، DRM، محدودیت نرخ، بررسی ربات، در دسترس‌نبودن).
بعضی سایت‌ها IP مراکز داده را مسدود می‌کنند — دلیلی دیگر که پروفایل رایگان، با اتصال خودِ تو، جایی کار می‌کند که کانتینر ابری نمی‌تواند. پخش زنده و محتوای دارای DRM پشتیبانی نمی‌شود و ربات **تلاشی** برای دور زدن ورود، CAPTCHA یا بررسی ربات نمی‌کند.
برای افزودن رفتار ویژه‌ی یک سایت [`docs/adding-adapters.md`](docs/adding-adapters.md) و برای به‌روزرسانی امن yt-dlp [`docs/updating-dependencies.md`](docs/updating-dependencies.md) را ببین.

محدودیت‌های شناخته‌شده‌ی پروفایل رایگان: ربات فقط وقتی در دسترس است که کامپیوتر روشن باشد و `npm run engine` اجرا شود؛ نشانی تونل سریع با هر راه‌اندازی مجدد عوض می‌شود (موتور خودش دوباره ثبتش می‌کند) و تضمین پایداری ندارد؛ سهمیه‌های Workers Free اعمال می‌شود.
پروفایل Containers پیاده‌سازی و تست شده، اما روی Cloudflare Containers اجرا نشده است.

## مستندات

| | |
|---|---|
| [`docs/free-plan-hybrid.md`](docs/free-plan-hybrid.md) | پروفایل رایگان: راه‌اندازی، استفاده‌ی روزانه، محدودیت‌ها |
| [`docs/architecture.md`](docs/architecture.md) | اجزا، جریان درخواست، ماشین حالت، بازیابی |
| [`docs/security.md`](docs/security.md) | مدل تهدید و لایه‌های SSRF |
| [`docs/operations.md`](docs/operations.md) | پیکربندی، پایش، عیب‌یابی، بازگشت به نسخه‌ی قبل |
| [`docs/large-file-delivery.md`](docs/large-file-delivery.md) | روش‌های تحویل و سیاست حجم |
| [`docs/platform-constraints.md`](docs/platform-constraints.md) | واقعیت‌های Cloudflare، تلگرام و yt-dlp که طراحی به آن‌ها تکیه دارد |
| [`docs/test-report.md`](docs/test-report.md) | چه چیزی، چگونه تست شد و چه چیزی نه |

## استفاده‌ی مسئولانه

فقط محتوایی را دانلود کن که اجازه‌ی دانلودش را داری. ربات DRM، پرداخت‌های اجباری (paywall) و کنترل‌های دسترسی را دور نمی‌زند، به‌طور پیش‌فرض پس از تحویل هیچ رسانه‌ای نگه نمی‌دارد و مسئولیت نحوه‌ی استفاده از هر استقرار با اپراتور آن است.

## مجوز

[MIT](LICENSE). اجزای شخص ثالث مجوز خودشان را حفظ می‌کنند (yt-dlp: Unlicense؛ FFmpeg: LGPL/GPL بسته به نسخه‌ی ساخت؛ Telethon: MIT؛ telegram-bot-api: BSL-1.0).

</div>

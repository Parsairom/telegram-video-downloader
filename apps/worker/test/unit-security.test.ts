import { describe, expect, it } from "vitest";
import { signDownloadToken, signJobToken, timingSafeEqual, verifyDownloadToken, verifyJobToken } from "../src/security/hmac";
import { extractUrls, isBlockedIpLiteral, normalizeUrl, resolvesToPublicAddresses, validateUrl } from "../src/security/url";
import { isValidWebhookSecret, verifyWebhookSecret } from "../src/security/webhook";
import { createLogger, redact, redactString } from "../src/log";

describe("URL validation / SSRF", () => {
  it.each([
    "https://example.com/video.mp4",
    "http://example.com:8080/a?b=c",
    "https://sub.domain.example.org/watch?v=abc",
    "https://8.8.8.8/x.mp4",
    "https://[2001:4860:4860::8888]/x",
    "https://xn--mgbaam7a8h.example/x",
  ])("accepts public URL %s", (url) => {
    const r = validateUrl(url);
    expect(r.ok).toBe(true);
  });

  it.each([
    ["file:///etc/passwd", "invalid_url"],
    ["data:text/plain;base64,AAAA", "invalid_url"],
    ["gopher://example.com/", "invalid_url"],
    ["ftp://example.com/x", "invalid_url"],
    ["javascript:alert(1)", "invalid_url"],
    ["http://localhost/x", "blocked_url"],
    ["http://LOCALHOST./x", "blocked_url"],
    ["http://foo.localhost/x", "blocked_url"],
    ["http://127.0.0.1/x", "blocked_url"],
    ["http://127.1/x", "blocked_url"],
    ["http://2130706433/x", "blocked_url"],
    ["http://0x7f000001/x", "blocked_url"],
    ["http://0177.0.0.1/x", "blocked_url"],
    ["http://10.0.0.5/x", "blocked_url"],
    ["http://172.16.0.1/x", "blocked_url"],
    ["http://192.168.1.1/x", "blocked_url"],
    ["http://169.254.169.254/latest/meta-data/", "blocked_url"],
    ["http://metadata.google.internal/computeMetadata/v1/", "blocked_url"],
    ["http://100.64.0.1/x", "blocked_url"],
    ["http://[::1]/x", "blocked_url"],
    ["http://[::ffff:127.0.0.1]/x", "blocked_url"],
    ["http://[::ffff:7f00:1]/x", "blocked_url"],
    ["http://[fe80::1]/x", "blocked_url"],
    ["http://[fd00::1]/x", "blocked_url"],
    ["http://[64:ff9b::7f00:1]/x", "blocked_url"],
    ["http://[2002:7f00:1::]/x", "blocked_url"],
    ["http://intranet/x", "blocked_url"],
    ["http://printer.local/x", "blocked_url"],
    ["http://user:pass@example.com/x", "blocked_url"],
    ["http://example.com:22/x", "blocked_url"],
    ["http://example.com:6379/x", "blocked_url"],
    ["http://exa mple.com/x", "invalid_url"],
    ["", "invalid_url"],
    ["not a url", "invalid_url"],
    [`http://${"a".repeat(3000)}.com`, "invalid_url"],
  ])("rejects %s", (url, code) => {
    const r = validateUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it("classifies IP literals", () => {
    expect(isBlockedIpLiteral("8.8.8.8")).toBe(false);
    expect(isBlockedIpLiteral("2606:4700:4700::1111")).toBe(false);
    for (const bad of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "::ffff:10.0.0.1", "100::1", "[::1]"]) {
      expect(isBlockedIpLiteral(bad), bad).toBe(true);
    }
  });

  it("normalises URLs for duplicate detection", () => {
    const a = validateUrl("https://Example.com:443/watch/?v=1&utm_source=x&fbclid=y&b=2#t=5");
    const b = validateUrl("https://example.com/watch?b=2&v=1");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.normalized).toBe(b.normalized);
    expect(normalizeUrl(new URL("http://example.com:80/x"))).toBe("http://example.com/x");
  });

  it("extracts URLs from messages (plain text, hidden links, bare domains) without duplicates", () => {
    expect(extractUrls("see https://youtu.be/abc, ok")).toEqual(["https://youtu.be/abc"]);
    expect(extractUrls("لینک: https://a.com/x?y=1&z=2).")).toEqual(["https://a.com/x?y=1&z=2"]);
    expect(extractUrls("youtube.com/watch?v=abc")).toEqual(["https://youtube.com/watch?v=abc"]);
    expect(extractUrls("hello world")).toEqual([]);
    expect(extractUrls("two https://a.com/1 https://b.com/2 https://a.com/1", ["https://c.com/3"])).toEqual(["https://c.com/3", "https://a.com/1", "https://b.com/2"]);
  });

  it("DNS check refuses names that resolve to internal addresses and tolerates DoH outages", async () => {
    const answer = (data: string[]) => async () => new Response(JSON.stringify({ Answer: data.map((d) => ({ type: d.includes(":") ? 28 : 1, data: d })) }));
    expect((await resolvesToPublicAddresses("example.com", answer(["93.184.216.34"]) as typeof fetch)).ok).toBe(true);
    const bad = await resolvesToPublicAddresses("evil.example", answer(["10.0.0.7"]) as typeof fetch);
    expect(bad.ok).toBe(false);
    expect((await resolvesToPublicAddresses("evil.example", answer(["8.8.8.8", "127.0.0.1"]) as typeof fetch)).ok).toBe(false); // one bad answer is enough
    const down = await resolvesToPublicAddresses("example.com", (async () => { throw new Error("offline"); }) as typeof fetch);
    expect(down).toEqual({ ok: true, resolved: false }); // the container still enforces the policy on every connection
  });
});

describe("HMAC tokens", () => {
  const secret = "unit-test-secret";
  it("job tokens bind to the job id", async () => {
    const t = await signJobToken(secret, "job_aaaaaaaaaaaa");
    expect(await verifyJobToken(secret, "job_aaaaaaaaaaaa", t)).toBe(true);
    expect(await verifyJobToken(secret, "job_bbbbbbbbbbbb", t)).toBe(false);
    expect(await verifyJobToken("other", "job_aaaaaaaaaaaa", t)).toBe(false);
    expect(await verifyJobToken(secret, "job_aaaaaaaaaaaa", t.slice(0, -2) + "xx")).toBe(false);
    expect(await verifyJobToken(secret, "job_aaaaaaaaaaaa", "")).toBe(false);
  });

  it("download tokens expire and cannot be reused for another object", async () => {
    const t = await signDownloadToken(secret, "job_x", 2_000);
    expect(await verifyDownloadToken(secret, "job_x", t, 1_999)).toBe(true);
    expect(await verifyDownloadToken(secret, "job_x", t, 2_001)).toBe(false); // expired
    expect(await verifyDownloadToken(secret, "job_y", t, 1_000)).toBe(false);
    const forged = `9999999999.${t.split(".")[1]}`; // extending the expiry invalidates the signature
    expect(await verifyDownloadToken(secret, "job_x", forged, 1_000)).toBe(false);
    expect(await verifyDownloadToken(secret, "job_x", "garbage", 1_000)).toBe(false);
  });

  it("compares in constant time and handles length differences", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("webhook secret", () => {
  const req = (secret?: string) => new Request("https://x.test/", { method: "POST", headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {} });
  it("verifies the header and never accepts when unconfigured", () => {
    expect(verifyWebhookSecret(req("s3cret-s3cret-s3cret"), "s3cret-s3cret-s3cret")).toBe(true);
    expect(verifyWebhookSecret(req("wrong"), "s3cret-s3cret-s3cret")).toBe(false);
    expect(verifyWebhookSecret(req(), "s3cret-s3cret-s3cret")).toBe(false);
    expect(verifyWebhookSecret(req(""), "")).toBe(false);
    expect(verifyWebhookSecret(req("x"), undefined)).toBe(false);
  });
  it("validates the secret format Telegram accepts", () => {
    expect(isValidWebhookSecret("abcDEF0123456789_-xyz")).toBe(true);
    expect(isValidWebhookSecret("short")).toBe(false);
    expect(isValidWebhookSecret("has space has space")).toBe(false);
  });
});

describe("log redaction", () => {
  it("removes bot tokens, bearer tokens, signed URL parameters and secret-looking keys", () => {
    expect(redactString("call https://api.telegram.org/bot123456:ABCdefGhIJKlmNoPQRsTUVwxyz0123456789/getMe")).not.toContain("ABCdef");
    expect(redactString("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [redacted]");
    expect(redactString("https://x.test/f?X-Amz-Signature=deadbeef&a=1")).toBe("https://x.test/f?X-Amz-Signature=[redacted]&a=1");
    const out = redact({ ok: 1, bot_token: "123456:ABCdefGhIJKlmNoPQRsTUVwxyz0123456789", nested: { password: "p", cookie: "c", fine: "yes" }, list: ["Bearer zzz"] }) as Record<string, any>;
    expect(out.bot_token).toBe("[redacted]");
    expect(out.nested).toEqual({ password: "[redacted]", cookie: "[redacted]", fine: "yes" });
    expect(out.list[0]).toBe("Bearer [redacted]");
  });

  it("filters by level and attaches correlation ids", () => {
    const lines: string[] = [];
    const log = createLogger("warn", {}, (l) => lines.push(l)).child({ correlationId: "cid-1" });
    log.info("hidden");
    log.warn("shown", { token: "x" });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: "warn", msg: "shown", correlationId: "cid-1", token: "[redacted]" });
  });
});

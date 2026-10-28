/**
 * URL intake validation and SSRF protection (first line of defence).
 *
 * The media container re-validates every URL, resolves DNS itself and enforces the same IP policy
 * on every connection yt-dlp makes (see apps/media-container/app/security.py), which is what
 * actually stops redirects, DNS rebinding and secondary requests made by extractors.
 */

export type UrlCheck =
  | { ok: true; url: URL; normalized: string; host: string }
  | { ok: false; code: "invalid_url" | "blocked_url"; reason: string };

const MAX_URL_LENGTH = 2048;

const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
  113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 445, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 2375, 2376, 3306, 3389, 4045, 5432, 5900,
  6000, 6379, 6665, 6666, 6667, 6668, 6669, 8081, 9200, 9300, 11211, 27017,
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".home.arpa",
  ".in-addr.arpa",
  ".ip6.arpa",
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default.svc",
]);

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "igshid",
  "igsh",
  "si",
  "feature",
  "pp",
  "ref_src",
  "ref_url",
  "mc_cid",
  "mc_eid",
  "_ga",
]);

/** Parse a dotted-quad IPv4 string into 4 octets, or null if it is not one. */
export function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map((p) => Number(p));
  if (parts.some((p) => p > 255)) return null;
  return parts as [number, number, number, number];
}

export function isPrivateIPv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true; // "this" network
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol + TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Expand an IPv6 literal (without brackets) to eight 16-bit groups, or null if malformed. */
export function parseIPv6(input: string): number[] | null {
  let host = input;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  if (!host.includes(":")) return null;

  // embedded IPv4 tail (::ffff:1.2.3.4)
  let tail: number[] = [];
  const lastColon = host.lastIndexOf(":");
  const maybeV4 = host.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    host = host.slice(0, lastColon + 1) + "0:0";
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

export function isPrivateIPv6(groups: number[]): boolean {
  const g = (i: number) => groups[i] ?? 0;
  const allZeroUntil = (n: number) => groups.slice(0, n).every((x) => x === 0);

  if (groups.every((x) => x === 0)) return true; // ::
  if (allZeroUntil(7) && g(7) === 1) return true; // ::1
  if ((g(0) & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g(0) & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g(0) & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g(0) & 0xff00) === 0xff00) return true; // multicast
  if (g(0) === 0x2001 && g(1) === 0x0db8) return true; // documentation
  if (g(0) === 0x0100 && g(1) === 0 && g(2) === 0 && g(3) === 0) return true; // 100::/64 discard-only
  // IPv4-mapped / compatible / NAT64 / 6to4 → check the embedded IPv4
  const embedded = (hi: number, lo: number): [number, number, number, number] => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (allZeroUntil(5) && (g(5) === 0xffff || g(5) === 0)) return isPrivateIPv4(embedded(g(6), g(7)));
  if (g(0) === 0x0064 && g(1) === 0xff9b) return isPrivateIPv4(embedded(g(6), g(7))); // 64:ff9b::/96
  if (g(0) === 0x2002) return isPrivateIPv4(embedded(g(1), g(2))); // 6to4
  return false;
}

/** True when `host` (as produced by URL.hostname) is an IP literal in a blocked range. */
export function isBlockedIpLiteral(host: string): boolean {
  const v4 = parseIPv4(host);
  if (v4) return isPrivateIPv4(v4);
  const v6 = parseIPv6(host);
  if (v6) return isPrivateIPv6(v6);
  return false;
}

export function validateUrl(raw: string): UrlCheck {
  const input = raw.trim();
  if (!input) return { ok: false, code: "invalid_url", reason: "empty" };
  if (input.length > MAX_URL_LENGTH) return { ok: false, code: "invalid_url", reason: "too long" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(input)) return { ok: false, code: "invalid_url", reason: "whitespace or control characters" };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, code: "invalid_url", reason: "not a valid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "invalid_url", reason: `unsupported scheme ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, code: "blocked_url", reason: "credentials in URL are not allowed" };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, code: "invalid_url", reason: "missing host" };

  if (url.port) {
    const port = Number(url.port);
    if (BLOCKED_PORTS.has(port)) return { ok: false, code: "blocked_url", reason: `port ${port} is not allowed` };
  }

  if (isBlockedIpLiteral(host)) return { ok: false, code: "blocked_url", reason: "IP address is not publicly routable" };

  const isIpLiteral = parseIPv4(host) !== null || host.startsWith("[");
  if (!isIpLiteral) {
    if (!host.includes(".")) return { ok: false, code: "blocked_url", reason: "single-label hostname" };
    if (BLOCKED_HOSTS.has(host)) return { ok: false, code: "blocked_url", reason: "internal hostname" };
    if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, code: "blocked_url", reason: "internal hostname" };
    // numeric-looking hostnames that the URL parser could not normalise into a dotted quad
    if (/^[0-9.x]+$/i.test(host)) return { ok: false, code: "blocked_url", reason: "ambiguous numeric host" };
  }

  return { ok: true, url, normalized: normalizeUrl(url), host };
}

/** Canonical form used for duplicate detection: no fragment, default port dropped, tracking params removed. */
export function normalizeUrl(url: URL): string {
  const u = new URL(url.toString());
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (k.startsWith("utm_") || TRACKING_PARAMS.has(k.toLowerCase())) continue;
    keep.push([k, v]);
  }
  keep.sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const BARE_DOMAIN = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?$/i;

/** Pull candidate URLs out of a Telegram message (plain text + hidden hyperlinks). */
export function extractUrls(text: string, entityUrls: string[] = []): string[] {
  const found: string[] = [];
  const add = (u: string) => {
    const cleaned = u.replace(/[.,;:!?)\]}»”’'"،؛]+$/u, "");
    if (cleaned && !found.includes(cleaned)) found.push(cleaned);
  };
  for (const u of entityUrls) add(u);
  for (const m of text.matchAll(URL_IN_TEXT)) add(m[0]);
  if (found.length === 0) {
    const bare = text.trim();
    if (bare && !/\s/.test(bare) && BARE_DOMAIN.test(bare)) add(`https://${bare}`);
  }
  return found;
}

/** Optional defence-in-depth: resolve via DNS-over-HTTPS and make sure no answer is internal. */
export async function resolvesToPublicAddresses(
  host: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<{ ok: boolean; reason?: string; resolved: boolean }> {
  if (parseIPv4(host) || host.startsWith("[")) return { ok: true, resolved: false };
  const query = async (type: "A" | "AAAA"): Promise<string[] | null> => {
    try {
      const res = await fetchImpl(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
      return (body.Answer ?? []).filter((a) => a.type === (type === "A" ? 1 : 28)).map((a) => a.data);
    } catch {
      return null;
    }
  };
  const [a, aaaa] = await Promise.all([query("A"), query("AAAA")]);
  if (a === null && aaaa === null) return { ok: true, resolved: false }; // DoH unavailable: container still enforces
  for (const ip of [...(a ?? []), ...(aaaa ?? [])]) {
    if (isBlockedIpLiteral(ip)) return { ok: false, reason: `hostname resolves to a non-public address (${ip})`, resolved: true };
  }
  return { ok: true, resolved: true };
}

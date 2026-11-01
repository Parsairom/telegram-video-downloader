#!/usr/bin/env node
// Runs the media engine on THIS computer (free-plan hybrid profile) and exposes it through a free Cloudflare quick tunnel.
//
//   node scripts/run-engine.mjs                start tunnel + engine, restart both if either dies
//   node scripts/run-engine.mjs --no-tunnel    engine only; ENGINE_PUBLIC_URL (https, in .env) must point at it
//   node scripts/run-engine.mjs --no-register  do not register with the Worker (local testing)
//
// How it fits together: cloudflared gives http://127.0.0.1:<port> a public https://<random>.trycloudflare.com URL; the engine
// registers that URL with the Worker (POST <PUBLIC_BASE_URL>/internal/engine/register, Bearer CONTAINER_API_KEY) on start-up and
// every 30 s, so the changing URL never has to be copied by hand. Telegram uploads (up to ~2 GB) go straight from this
// machine to Telegram over MTProto and never pass through the tunnel.
//
// Reads .env (see .env.example). Secrets are passed to the engine's environment only, never on a command line or to the log.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { URL } from "node:url";
import { ROOT, fail, readEnvFile, redact, requireEnv, step } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const env = readEnvFile();
const win = process.platform === "win32";

requireEnv(env, ["BOT_TOKEN", "CONTAINER_API_KEY"]);
if (!args.has("--no-register")) requireEnv(env, ["PUBLIC_BASE_URL"]);

// 18080, not 8080: 8080 is commonly taken by other local tools
const PORT = Number(env.ENGINE_PORT || 18080);
const ENGINE_DIR = join(ROOT, "apps", "media-container");
const WORK_DIR = env.ENGINE_WORK_DIR || join(ROOT, "engine-work");
mkdirSync(WORK_DIR, { recursive: true });

// ── locate the tools ────────────────────────────────────────────────────────────────────────────────────────────────────
function pythonBin() {
  for (const p of [join(ROOT, ".venv", "Scripts", "python.exe"), join(ROOT, ".venv", "bin", "python")]) if (existsSync(p)) return p;
  return win ? "python" : "python3";
}

function onPath(name) {
  const r = spawnSync(win ? "where" : "which", [name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function findFfmpegDir() {
  const direct = onPath("ffmpeg");
  if (direct) return null; // already on PATH
  const base = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Microsoft", "WinGet", "Packages");
  if (!existsSync(base)) return null;
  for (const pkg of readdirSync(base).filter((n) => /ffmpeg/i.test(n))) {
    const pkgDir = join(base, pkg);
    for (const sub of readdirSync(pkgDir)) {
      const bin = join(pkgDir, sub, "bin");
      if (existsSync(join(bin, win ? "ffmpeg.exe" : "ffmpeg"))) return bin;
    }
  }
  return null;
}

function cloudflaredBin() {
  const local = join(ROOT, "tools", win ? "cloudflared.exe" : "cloudflared");
  if (existsSync(local)) return local;
  return onPath("cloudflared");
}

// ── environment for the engine (never log this) ─────────────────────────────────────────────────────────────────────────
function engineEnv(publicUrl) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^CLOUDFLARE_|^CF_|^WRANGLER_/i.test(k)) delete base[k];
  const ffmpegDir = findFfmpegDir();
  if (ffmpegDir) base.PATH = `${ffmpegDir}${delimiter}${base.PATH ?? base.Path ?? ""}`;
  const set = (k, v) => {
    if (v !== undefined && v !== "") base[k] = String(v);
  };
  set("PORT", PORT);
  set("WORK_DIR", WORK_DIR);
  set("LOG_LEVEL", env.LOG_LEVEL || "info");
  set("PYTHONUTF8", "1");
  set("PYTHONIOENCODING", "utf-8");
  set("BOT_TOKEN", env.BOT_TOKEN);
  set("CONTAINER_API_KEY", env.CONTAINER_API_KEY);
  set("TELEGRAM_API_ID", env.TELEGRAM_API_ID);
  set("TELEGRAM_API_HASH", env.TELEGRAM_API_HASH);
  set("TELEGRAM_PROXY", env.TELEGRAM_PROXY);
  set("UPSTREAM_PROXY", env.UPSTREAM_PROXY);
  set("MAX_CONCURRENT_JOBS", env.ENGINE_MAX_CONCURRENT_JOBS || 2);
  set("MTPROTO_ENABLED", env.MTPROTO_ENABLED || "true");
  set("COOKIES_FILE", env.COOKIES_FILE);
  set("ENGINE_NAME", env.ENGINE_NAME || "local-engine");
  if (!args.has("--no-register")) {
    set("WORKER_BASE_URL", env.PUBLIC_BASE_URL);
    set("ENGINE_PUBLIC_URL", publicUrl);
  } else {
    delete base.WORKER_BASE_URL;
    delete base.ENGINE_PUBLIC_URL;
  }
  delete base.TVD_NO_AUTOAPP;
  return base;
}

// ── process supervision ─────────────────────────────────────────────────────────────────────────────────────────────────
const children = new Set();
let stopping = false;

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (win) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

function pipeLogs(child, tag, onLine) {
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        onLine?.(line);
        console.log(`[${tag}] ${redact(line).slice(0, 400)}`);
      }
    });
  }
}

/** Starts a quick tunnel and resolves with its public URL (or rejects after 90 s). */
function startTunnel() {
  const bin = cloudflaredBin();
  if (!bin) fail("cloudflared not found. Put cloudflared.exe in ./tools (see docs/operations.md) or install it, or use --no-tunnel with ENGINE_PUBLIC_URL.");
  const protocol = env.TUNNEL_PROTOCOL || "auto";
  const child = spawn(bin, ["tunnel", "--no-autoupdate", "--protocol", protocol, "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.add(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the tunnel did not report a public URL within 90 s")), 90_000);
    let expired = 0;
    pipeLogs(child, "tunnel", (line) => {
      // A quick tunnel that could not connect for a few minutes is deleted by Cloudflare; retrying it forever never works,
      // so end this cloudflared process and let the main loop request a fresh tunnel (and register the new URL).
      if (/Unauthorized: Tunnel not found/i.test(line) && ++expired >= 2) {
        console.log("  ! Cloudflare no longer knows this quick tunnel (it expired before it could connect) — requesting a new one");
        killTree(child);
      }
      // api.trycloudflare.com is the control API that shows up in error lines, never the tunnel itself
      const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[0] });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      children.delete(child);
      reject(new Error(`cloudflared exited with code ${code}`));
    });
  });
}

function startEngine(publicUrl) {
  const child = spawn(pythonBin(), ["-m", "uvicorn", "app.api:app", "--host", "127.0.0.1", "--port", String(PORT), "--no-access-log", "--timeout-graceful-shutdown", "25"], {
    cwd: ENGINE_DIR,
    env: engineEnv(publicUrl),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  pipeLogs(child, "engine");
  return child;
}

async function waitHealthy(url, label, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until && !stopping) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`  ! ${label} did not answer /health within ${seconds}s`);
  return false;
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal}: stopping (the engine tells the Worker it is going offline)…`);
  // give uvicorn a moment to run its lifespan shutdown (de-registration) before the hard kill
  for (const c of children) if (!win) c.kill("SIGTERM");
  setTimeout(() => {
    for (const c of children) killTree(c);
    process.exit(0);
  }, win ? 0 : 6000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── pre-flight ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** True when something accepts TCP connections at the proxy's host:port. */
function proxyReachable(raw) {
  let target;
  try {
    target = new URL(raw);
  } catch {
    return Promise.resolve(false);
  }
  const port = Number(target.port) || (target.protocol.startsWith("socks") ? 1080 : 80);
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.hostname, port });
    socket.setTimeout(3000);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

/** A dead proxy is the most common reason for downloads and Telegram uploads failing, so say so before anything else does. */
async function warnAboutProxies() {
  for (const key of ["TELEGRAM_PROXY", "UPSTREAM_PROXY"]) {
    if (env[key] && !(await proxyReachable(env[key]))) {
      console.log(`  ! ${key}=${env[key]} does not answer. Start your proxy/VPN app, or fix the port in .env — downloads from blocked sites and Telegram uploads fail until it does.`);
    }
  }
}

// ── main loop ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log(`Media engine for the free profile. Work dir: ${WORK_DIR}`);
let failures = 0;
while (!stopping) {
  let tunnel = null;
  await warnAboutProxies();
  try {
    let publicUrl = env.ENGINE_PUBLIC_URL?.replace(/\/+$/, "");
    if (!args.has("--no-tunnel")) {
      step("Starting the Cloudflare quick tunnel");
      tunnel = await startTunnel();
      publicUrl = tunnel.url;
      console.log(`  public URL: ${publicUrl}`);
    } else if (!args.has("--no-register") && !/^https:\/\//.test(publicUrl ?? "")) {
      fail("--no-tunnel needs ENGINE_PUBLIC_URL=https://… in .env");
    }

    step("Starting the media engine");
    const engine = startEngine(publicUrl);
    const up = await waitHealthy(`http://127.0.0.1:${PORT}`, "engine", 60);
    if (!up) throw new Error("the engine did not become healthy");
    console.log(`  engine healthy on 127.0.0.1:${PORT}`);
    writeFileSync(join(WORK_DIR, "engine-url.txt"), `${publicUrl ?? ""}\n`);
    if (tunnel) {
      // informational only: this machine may not resolve *.trycloudflare.com even though the Worker can reach it
      const reachable = await waitHealthy(publicUrl, "tunnel URL (from this machine)", 25);
      console.log(`  tunnel reachable from this machine: ${reachable ? "yes" : "not verified (DNS may be filtered locally; the Worker's view is what counts)"}`);
    }
    console.log("\n✔ Engine online. Leave this window open. Ctrl+C to stop.\n");
    failures = 0;

    await new Promise((resolve) => {
      engine.once("exit", (code) => {
        console.log(`engine exited (code ${code})`);
        resolve();
      });
      tunnel?.child.once("exit", (code) => {
        console.log(`tunnel exited (code ${code})`);
        resolve();
      });
    });
  } catch (error) {
    console.error(`✖ ${error.message}`);
  }
  for (const c of children) killTree(c);
  children.clear();
  if (stopping) break;
  failures += 1;
  const delay = Math.min(60, 3 * failures);
  console.log(`restarting in ${delay}s (a restarted quick tunnel gets a new URL; the engine registers it automatically)…`);
  await new Promise((r) => setTimeout(r, delay * 1000));
}

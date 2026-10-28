#!/usr/bin/env node
// Regenerates apps/media-container/requirements.lock from pyproject's runtime dependencies in a clean virtualenv.
// Use it as the first step of the upgrade procedure in docs/updating-dependencies.md.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, fail } from "./lib.mjs";

const container = join(ROOT, "apps", "media-container");
const pyproject = readFileSync(join(container, "pyproject.toml"), "utf8");
// the list ends at the first line that is just "]" — a plain /\[...\]/ match would stop inside extras such as "yt-dlp[default]"
const deps = [...(/^dependencies\s*=\s*\[\s*\n([\s\S]*?)^\]/m.exec(pyproject)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (deps.length < 5 || !deps.some((d) => d.startsWith("yt-dlp"))) fail(`could not read dependencies from pyproject.toml (got: ${deps.join(", ") || "nothing"})`);

const dir = mkdtempSync(join(tmpdir(), "tvd-lock-"));
const python = process.platform === "win32" ? "python" : "python3";
const bin = join(dir, process.platform === "win32" ? "Scripts" : "bin", "python");
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
try {
  if (run(python, ["-m", "venv", dir]).status !== 0) fail("could not create a virtualenv");
  const index = process.env.PIP_INDEX_URL ? ["-i", process.env.PIP_INDEX_URL] : [];
  const install = run(bin, ["-m", "pip", "install", "-q", ...index, ...deps]);
  if (install.status !== 0) fail(`pip install failed:\n${install.stderr.slice(-800)}`);
  const frozen = run(bin, ["-m", "pip", "freeze"]).stdout.split(/\r?\n/).filter((l) => l && !/^(pip|setuptools|wheel|pywin32|colorama)==/i.test(l));
  const header = "# Pinned runtime dependencies for the media container (generated from a clean venv by scripts/lock-deps.mjs).\n# yt-dlp is pinned on purpose: see docs/updating-dependencies.md for the safe upgrade procedure.";
  writeFileSync(join(container, "requirements.lock"), `${header}\n${frozen.join("\n")}\n`);
  console.log(`✔ requirements.lock updated (${frozen.length} packages)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

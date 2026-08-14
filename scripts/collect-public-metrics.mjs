#!/usr/bin/env node
/**
 * Collect distribution-only metrics from the official npm and GitHub APIs.
 *
 * This script never receives product telemetry. It snapshots public package/repository
 * counters so short-retention APIs (notably npm's 7-day per-version window) remain useful
 * over time.
 *
 * SEC-7 (2026-08-13 audit, operator decision): repository *traffic* (views/clones) is
 * deliberately NOT collected. Traffic data is scoped by GitHub to push-access holders, and
 * everything this workflow can write in a public repository (commits, logs, artifacts) is
 * public — so snapshotting it here would irreversibly publish admin-only data. The operator
 * reads traffic in GitHub Insights directly; preserving its history would require a private
 * sink (out of scope).
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_NPM_PACKAGE = "actradeck";
const DEFAULT_GITHUB_REPOSITORY = "actradeck/actradeck";
const DEFAULT_OUTPUT_DIR = "metrics/public";
const REQUEST_TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const options = {
    date: yesterdayUtc(),
    npmPackage: process.env.ACTRADECK_METRICS_NPM_PACKAGE || DEFAULT_NPM_PACKAGE,
    repository:
      process.env.ACTRADECK_METRICS_GITHUB_REPOSITORY ||
      process.env.GITHUB_REPOSITORY ||
      DEFAULT_GITHUB_REPOSITORY,
    outputDir: process.env.ACTRADECK_METRICS_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const [name, inline] = arg.split("=", 2);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`${name} requires a value`);
    if (name === "--date") options.date = value;
    else if (name === "--npm-package") options.npmPackage = value;
    else if (name === "--repository") options.repository = value;
    else if (name === "--output-dir") options.outputDir = value;
    else throw new Error(`unknown option: ${name}`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error("--date must be YYYY-MM-DD");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(options.repository)) {
    throw new Error("--repository must be owner/name");
  }
  return options;
}

function yesterdayUtc(now = new Date()) {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "actradeck-public-metrics/1",
      ...headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function collectNpm(packageName, date) {
  const encoded = encodeURIComponent(packageName);
  const [daily, versions] = await Promise.all([
    fetchJson(`https://api.npmjs.org/downloads/point/${date}:${date}/${encoded}`),
    fetchJson(`https://api.npmjs.org/versions/${encoded}/last-week`),
  ]);
  return {
    package: packageName,
    daily: {
      day: date,
      downloads: Number(daily.downloads) || 0,
    },
    versions_last_week: {
      requested_period: "last-week",
      downloads:
        versions && typeof versions.downloads === "object" && versions.downloads !== null
          ? versions.downloads
          : {},
    },
  };
}

async function collectGitHub(repository, token) {
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // Releases are public data; the token only lifts the unauthenticated rate limit.
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const releases = await fetchJson(`${base}/releases?per_page=100`, headers);
  const assets = Array.isArray(releases)
    ? releases.flatMap((release) =>
        Array.isArray(release.assets)
          ? release.assets.map((asset) => ({
              release: String(release.tag_name ?? ""),
              name: String(asset.name ?? ""),
              download_count: Number(asset.download_count) || 0,
              updated_at: typeof asset.updated_at === "string" ? asset.updated_at : null,
            }))
          : [],
      )
    : [];
  return {
    repository,
    release_assets: assets,
    release_asset_downloads_total: assets.reduce((sum, asset) => sum + asset.download_count, 0),
  };
}

async function writeSnapshot(outputDir, date, snapshot) {
  const dir = resolve(outputDir);
  await mkdir(dir, { recursive: true });
  const target = resolve(dir, `${date}.json`);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, target);
  return target;
}

export async function collectPublicMetrics(options) {
  const [npm, github] = await Promise.all([
    collectNpm(options.npmPackage, options.date),
    collectGitHub(options.repository, process.env.GITHUB_TOKEN),
  ]);
  return {
    schema_version: 1,
    collected_at: new Date().toISOString(),
    snapshot_day: options.date,
    semantics: "distribution_signals_not_users_or_installs",
    npm,
    github,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = await collectPublicMetrics(options);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  const path = await writeSnapshot(options.outputDir, options.date, snapshot);
  process.stdout.write(`wrote ${path}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(
      `collect-public-metrics: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

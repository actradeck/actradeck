import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { collectPublicMetrics } from "./collect-public-metrics.mjs";

const originalFetch = globalThis.fetch;
const originalToken = process.env.GITHUB_TOKEN;

before(() => {
  process.env.GITHUB_TOKEN = "test-token-never-sent";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/downloads/point/")) {
      return Response.json({ downloads: 7, package: "actradeck" });
    }
    if (url.includes("/versions/")) {
      return Response.json({ downloads: { "0.7.0": 5, "0.6.0": 2 } });
    }
    if (url.endsWith("/releases?per_page=100")) {
      return Response.json([
        {
          tag_name: "v0.7.0",
          assets: [
            {
              name: "actradeck.tar.gz",
              download_count: 9,
              updated_at: "2026-08-09T00:00:00Z",
            },
          ],
        },
      ]);
    }
    throw new Error(`unexpected URL: ${url}`);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
});

test("collects distribution signals without product usage fields", async () => {
  const snapshot = await collectPublicMetrics({
    date: "2026-08-09",
    npmPackage: "actradeck",
    repository: "actradeck/actradeck",
    outputDir: "unused",
    dryRun: true,
  });

  assert.equal(snapshot.npm.daily.downloads, 7);
  assert.deepEqual(snapshot.npm.versions_last_week.downloads, { "0.7.0": 5, "0.6.0": 2 });
  assert.equal(snapshot.github.release_asset_downloads_total, 9);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /session_id|event_id|command|prompt|cwd|installation_id/,
  );
  // SEC-7 (2026-08-13 監査・operator 決定): admin 限定の traffic データ (views/clones/uniques)
  // を public git 履歴へ載せない。フィールドの再導入はこの pin を意図的に外すことを要求する。
  assert.doesNotMatch(JSON.stringify(snapshot), /traffic|views|clones|uniques/);
});

test("traffic endpoints are never fetched (SEC-7)", async () => {
  const fetched = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetched.push(String(input));
    return prev(input);
  };
  try {
    await collectPublicMetrics({
      date: "2026-08-09",
      npmPackage: "actradeck",
      repository: "actradeck/actradeck",
      outputDir: "unused",
      dryRun: true,
    });
  } finally {
    globalThis.fetch = prev;
  }
  assert.ok(fetched.length > 0);
  for (const url of fetched) {
    assert.doesNotMatch(url, /\/traffic\//);
  }
});

#!/usr/bin/env node
// Generate Japanese static topic pages from the bilingual English topic sources.
// The source pages keep data-i18n attributes so app.js can toggle language in-place;
// this script makes crawlable /ja/<slug> URLs with Japanese HTML as the served default.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { JSDOM } = require("jsdom");

const SITE = "https://actradeck.io";
const TOPICS = [
  {
    slug: "control-plane-for-coding-agents",
    titleJa: "コーディングエージェントの統制レイヤー | ActraDeck",
    descJa:
      "ActraDeck は Claude Code や Codex の前に立つ、ローカルファーストな統制レイヤーです。承認、秘匿マスク、監査証跡、再生をひとつのコックピットに集約します。",
  },
  {
    slug: "claude-code-codex-approval-gate",
    titleJa: "Claude Code と Codex の承認ゲート | ActraDeck",
    descJa:
      "ActraDeck は Claude Code と Codex の高リスク操作を人の承認待ちで保留し、拒否・許可・セッション内許可をひとつのコックピットで扱います。",
  },
  {
    slug: "coding-agent-secret-redaction",
    titleJa: "コーディングエージェントの秘匿マスク | ActraDeck",
    descJa:
      "ActraDeck は鍵、トークン、.env 値などを保存前にマスクし、コックピットと監査証跡には秘匿マーカーと種別ごとの件数だけを残します。",
  },
  {
    slug: "coding-agent-audit-trail",
    titleJa: "コーディングエージェントの監査証跡と再生 | ActraDeck",
    descJa:
      "ActraDeck はコーディングエージェントのセッションを正規化・秘匿済みの監査証跡として残し、あとから再生・検証・エクスポートできます。",
  },
  {
    slug: "ingestion-contract",
    titleJa: "コーディングエージェント用アダプタの公開取込コントラクト | ActraDeck",
    descJa:
      "外部のコーディングツールを ActraDeck に追加するための公開取込コントラクトです。provider slug、source=external、正規化イベントでローカルコックピットに統合できます。",
  },
];

const topicSlugs = new Set(TOPICS.map((t) => t.slug));

function setAttr(doc, selector, attr, value) {
  const el = doc.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

function ensureAlternateLinks(doc, slug) {
  doc.querySelectorAll('link[rel="alternate"][hreflang]').forEach((el) => el.remove());
  const head = doc.querySelector("head");
  for (const [lang, href] of [
    ["en", `${SITE}/${slug}`],
    ["ja", `${SITE}/ja/${slug}`],
    ["x-default", `${SITE}/${slug}`],
  ]) {
    const link = doc.createElement("link");
    link.setAttribute("rel", "alternate");
    link.setAttribute("hreflang", lang);
    link.setAttribute("href", href);
    head.appendChild(link);
  }
}

function topicHref(href, lang) {
  if (!href || !href.startsWith("/") || href.startsWith("//") || href === "/" || href.startsWith("/#")) {
    return href;
  }
  const path = href.split("#")[0].split("?")[0].replace(/^\/ja\//, "").replace(/^\//, "");
  if (!topicSlugs.has(path)) return href;
  return lang === "ja" ? `/ja/${path}` : `/${path}`;
}

function syncTopicHrefs(doc, lang) {
  doc.querySelectorAll("a[href]").forEach((a) => {
    const raw = a.getAttribute("href");
    const en = topicHref(raw, "en");
    const ja = topicHref(raw, "ja");
    if (en !== raw || ja !== raw || raw?.startsWith("/ja/")) {
      a.setAttribute("data-href-en", en);
      a.setAttribute("data-href-ja", ja);
      a.setAttribute("href", lang === "ja" ? ja : en);
    }
  });
}

function renderI18n(doc, lang) {
  doc.querySelectorAll("[data-i18n]").forEach((el) => {
    const val = el.getAttribute(`data-${lang}`);
    if (val != null) el.innerHTML = val;
  });
}

function syncEnglishSource(topic) {
  const path = new URL(`../landing/${topic.slug}/index.html`, import.meta.url);
  const dom = new JSDOM(readFileSync(path, "utf8"));
  const doc = dom.window.document;
  ensureAlternateLinks(doc, topic.slug);
  syncTopicHrefs(doc, "en");
  writeFileSync(path, clean("<!doctype html>\n" + doc.documentElement.outerHTML + "\n"));
}

function generateJapanese(topic) {
  const src = new URL(`../landing/${topic.slug}/index.html`, import.meta.url);
  const outDir = new URL(`../landing/ja/${topic.slug}/`, import.meta.url);
  const out = new URL(`../landing/ja/${topic.slug}/index.html`, import.meta.url);
  const dom = new JSDOM(readFileSync(src, "utf8"));
  const doc = dom.window.document;

  doc.documentElement.setAttribute("lang", "ja");
  doc.documentElement.setAttribute("data-lp-locale", "ja");
  renderI18n(doc, "ja");
  syncTopicHrefs(doc, "ja");
  ensureAlternateLinks(doc, topic.slug);

  doc.querySelector("title").textContent = topic.titleJa;
  setAttr(doc, 'meta[name="description"]', "content", topic.descJa);
  setAttr(doc, 'link[rel="canonical"]', "href", `${SITE}/ja/${topic.slug}`);
  setAttr(doc, 'meta[property="og:title"]', "content", topic.titleJa);
  setAttr(doc, 'meta[property="og:description"]', "content", topic.descJa);
  setAttr(doc, 'meta[property="og:url"]', "content", `${SITE}/ja/${topic.slug}`);

  doc.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      const data = JSON.parse(script.textContent);
      if (data.headline) data.headline = topic.titleJa.replace(" | ActraDeck", "");
      if (data.mainEntityOfPage) data.mainEntityOfPage = `${SITE}/ja/${topic.slug}`;
      script.textContent = "\n" + JSON.stringify(data, null, 8) + "\n    ";
    } catch {
      // Keep non-JSON script contents untouched.
    }
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, clean("<!doctype html>\n" + doc.documentElement.outerHTML + "\n"));
}

function clean(html) {
  // HTML5 parsing re-parents the trailing newline after </html> into <body>,
  // so a naive parse→serialize→"\n" round-trip grows one blank line per run.
  // Collapse the whitespace run before </body></html> so output is idempotent.
  return html.replace(/[ \t]+\n/g, "\n").replace(/\s+(<\/body><\/html>)/, "\n$1");
}

for (const topic of TOPICS) {
  syncEnglishSource(topic);
  generateJapanese(topic);
}

console.log(`generated ${TOPICS.length} Japanese topic pages`);

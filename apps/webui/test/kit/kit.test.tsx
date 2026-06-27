/**
 * Adaptive Clarity kit プリミティブの a11y/契約（設計裁定 019ea263 D5）。
 *
 * react-dom/server の静的描画で role/aria/ネイティブ要素/テスト契約属性を固定する（node 環境）。
 * INV-A11Y-ICONBUTTON-LABEL / -ROLE / -SELECT-NATIVE / -TABLE-SEMANTICS を赤線化。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AppHeader,
  Button,
  Card,
  IconButton,
  InlineAlert,
  RangeSlider,
  Select,
  StatusBadge,
  Tag,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from "../../src/ui/kit/index.js";
import type { LivenessBadge } from "../../src/ui/liveness-display.js";

describe("Button / IconButton", () => {
  it("ネイティブ button(type=button)・disabled をネイティブ属性で透過", () => {
    const html = renderToStaticMarkup(
      <Button kind="primary" disabled title="t">
        実行
      </Button>,
    );
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="t"');
  });

  it("INV-A11Y-ICONBUTTON-LABEL: IconButton は aria-label を必ず出す", () => {
    const html = renderToStaticMarkup(<IconButton icon="close" label="閉じる" />);
    expect(html).toContain('aria-label="閉じる"');
    // title 未指定なら label をフォールバック。
    expect(html).toContain('title="閉じる"');
  });
});

describe("Tag / StatusBadge", () => {
  it("Tag は tone クラスとラベルを持つ", () => {
    const html = renderToStaticMarkup(<Tag tone="danger">高</Tag>);
    expect(html).toContain("ad-tag--danger");
    expect(html).toContain("高");
  });

  it("StatusBadge は liveness ラベル(suspected 表記)を保ち data-tone を出す", () => {
    const badge: LivenessBadge = { label: "STALLED?", tone: "warn", title: "stalled suspected" };
    const html = renderToStaticMarkup(<StatusBadge badge={badge} />);
    expect(html).toContain("STALLED?");
    expect(html).toContain('data-tone="warn"');
    expect(html).toContain("ad-tag--warn");
  });
});

describe("Table", () => {
  it("INV-A11Y-TABLE-SEMANTICS: table + 視覚非表示 caption + th scope=col", () => {
    const html = renderToStaticMarkup(
      <Table caption="セッション一覧">
        <THead>
          <Tr>
            <Th>状態</Th>
          </Tr>
        </THead>
        <TBody>
          <Tr>
            <Td>x</Td>
          </Tr>
        </TBody>
      </Table>,
    );
    expect(html).toContain("<table");
    expect(html).toContain("<caption");
    expect(html).toContain("ad-visually-hidden");
    expect(html).toContain('scope="col"');
  });
});

describe("Card", () => {
  it("as=li で li を描画（承認カード用）", () => {
    const html = renderToStaticMarkup(
      <Card as="li" tone="warn" data-testid="c">
        body
      </Card>,
    );
    expect(html).toContain("<li");
    expect(html).toContain("ad-card--warn");
    expect(html).toContain('data-testid="c"');
  });
});

describe("InlineAlert", () => {
  it("INV-A11Y-ROLE: error=alert / info=status・role 上書き可", () => {
    expect(renderToStaticMarkup(<InlineAlert kind="error" title="x" />)).toContain('role="alert"');
    expect(renderToStaticMarkup(<InlineAlert kind="info" title="x" />)).toContain('role="status"');
    expect(renderToStaticMarkup(<InlineAlert kind="info" title="x" role="alert" />)).toContain(
      'role="alert"',
    );
  });
});

describe("Select", () => {
  it("INV-A11Y-SELECT-NATIVE: ネイティブ select + label(htmlFor)", () => {
    const html = renderToStaticMarkup(
      <Select id="speed" label="再生速度" value="1" onChange={() => {}}>
        <option value="1">1x</option>
      </Select>,
    );
    expect(html).toContain("<select");
    expect(html).not.toContain('role="combobox"');
    expect(html).toContain('for="speed"');
    expect(html).toContain("再生速度");
  });
});

describe("RangeSlider", () => {
  it("ネイティブ range + aria-label", () => {
    const html = renderToStaticMarkup(
      <RangeSlider aria-label="再生位置" min={0} max={9} value={3} onChange={() => {}} />,
    );
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="再生位置"');
  });
});

describe("AppHeader", () => {
  it("header ランドマーク + スキップリンク(#main)", () => {
    const html = renderToStaticMarkup(
      <AppHeader productName="ActraDeck" tagline="Agent cockpit">
        <span>actions</span>
      </AppHeader>,
    );
    expect(html).toContain("<header");
    expect(html).toContain('href="#main"');
    expect(html).toContain("ActraDeck");
  });
});

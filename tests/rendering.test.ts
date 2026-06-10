/**
 * Regression tests for Telegram markdown rendering helpers
 * Covers nested lists, code blocks, tables, links, quotes, chunking, and other Telegram-specific render edge cases
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramPreviewSnapshot,
  chunkHtmlPreservingTags,
  escapeHtml,
  escapeHtmlAttribute,
  MAX_MESSAGE_LENGTH,
  renderMarkdownPreviewText,
  renderTelegramMessage,
} from "../lib/rendering.ts";

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

test("HTML helpers escape text and attribute contexts", () => {
  assert.equal(escapeHtml("<tag>&value"), "&lt;tag&gt;&amp;value");
  assert.equal(
    escapeHtmlAttribute(`"quoted" 'value' & <tag>`),
    "&quot;quoted&quot; &#39;value&#39; &amp; &lt;tag&gt;",
  );
});

test("HTML helpers chunk long text while preserving open tags", () => {
  const chunks = chunkHtmlPreservingTags(`<b>${"x".repeat(10)}</b>`, 12);
  assert.deepEqual(chunks, ["<b>xxxxx</b>", "<b>xxxxx</b>"]);
});

test("HTML helpers do not reopen void tags across chunks", () => {
  const chunks = chunkHtmlPreservingTags(`a<br>${"b".repeat(10)}`, 8);
  assert.deepEqual(chunks, ["a<br>bbb", "bbbbbbbb".slice(0, 7)]);
});

test("Malformed and boundary markdown renders safely", () => {
  const cases = [
    "",
    "```ts\nconst raw = '**not bold**'",
    `${"x".repeat(MAX_MESSAGE_LENGTH + 250)} end`,
    `surrogate-boundary: ${"🙂".repeat(120)}\uD83D`,
    [
      "> level 1",
      "> > level 2",
      "> > > level 3",
      "> > > > level 4",
      "> **bold quote",
    ].join("\n"),
  ];

  for (const markdown of cases) {
    let chunks: ReturnType<typeof renderTelegramMessage> = [];
    assert.doesNotThrow(() => {
      chunks = renderTelegramMessage(markdown, { mode: "markdown" });
    });
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
      assert.equal(
        countMatches(chunk.text, /<blockquote>/g),
        countMatches(chunk.text, /<\/blockquote>/g),
      );
      assert.equal(countMatches(chunk.text, /<b>/g), countMatches(chunk.text, /<\/b>/g));
      assert.equal(countMatches(chunk.text, /<i>/g), countMatches(chunk.text, /<\/i>/g));
      assert.equal(countMatches(chunk.text, /<pre>/g), countMatches(chunk.text, /<\/pre>/g));
    }
  }
});

test("Nested lists stay out of code blocks", () => {
  const chunks = renderTelegramMessage(
    "- Level 1\n  - Level 2\n    - Level 3 with **bold** text",
    { mode: "markdown" },
  );
  assert.ok(chunks.length > 0);
  assert.equal(
    chunks.some((chunk) => chunk.text.includes("<pre><code>")),
    false,
  );
  assert.equal(
    chunks.some((chunk) =>
      chunk.text.includes("<code>-</code> Level 3 with <b>bold</b> text"),
    ),
    true,
  );
});

test("Fenced code blocks preserve literal markdown", () => {
  const chunks = renderTelegramMessage('~~~ts\nconst value = "**raw**";\n~~~', {
    mode: "markdown",
  });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /<pre><code class="language-ts">/);
  assert.match(chunks[0]?.text ?? "", /\*\*raw\*\*/);
});

test("Underscores inside words do not become italic", () => {
  const chunks = renderTelegramMessage("Path: foo_bar_baz.txt and **bold**", {
    mode: "markdown",
  });
  assert.equal(chunks.length, 1);
  assert.equal((chunks[0]?.text ?? "").includes("<i>bar</i>"), false);
  assert.match(chunks[0]?.text ?? "", /<b>bold<\/b>/);
});

test("Bold markdown can span soft line breaks", () => {
  const chunks = renderTelegramMessage(
    "Скорее: **архитектурно — да,\nпрактически — почти**.",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(
    chunks[0]?.text ?? "",
    /Скорее: <b>архитектурно — да,\nпрактически — почти<\/b>\./,
  );
});

test("Quoted nested lists stay in blockquote rendering", () => {
  const chunks = renderTelegramMessage(
    "> Quoted intro\n> - nested item\n>   - deeper item",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /<blockquote>/);
  assert.match(chunks[0]?.text ?? "", /nested item/);
  assert.match(chunks[0]?.text ?? "", /<code>-<\/code> nested item/);
  assert.equal((chunks[0]?.text ?? "").includes("<pre><code>"), false);
});

test("Numbered lists use monospace numeric markers", () => {
  const chunks = renderTelegramMessage("1. first\n  2. second", {
    mode: "markdown",
  });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /<code>1\.<\/code> first/);
  assert.match(chunks[0]?.text ?? "", /<code>2\.<\/code> second/);
});

test("Ordered task lists preserve numeric markers in previews and final rendering", () => {
  const markdown = "1. [x] first\n2. [ ] second";
  assert.equal(renderMarkdownPreviewText(markdown), markdown);
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.equal(chunks.length, 1);
  assert.match(
    chunks[0]?.text ?? "",
    /<code>1\.<\/code> <code>\[x\]<\/code> first/,
  );
  assert.match(
    chunks[0]?.text ?? "",
    /<code>2\.<\/code> <code>\[ \]<\/code> second/,
  );
});

test("Leading indentation on the first markdown line stays intact", () => {
  const markdown = "  - nested bullet\n    - nested child";
  assert.equal(renderMarkdownPreviewText(markdown), markdown);
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.equal(chunks.length, 1);
  assert.match(
    chunks[0]?.text ?? "",
    /^\u00A0\u00A0<code>-<\/code> nested bullet/m,
  );
  assert.match(
    chunks[0]?.text ?? "",
    /^\u00A0\u00A0\u00A0\u00A0<code>-<\/code> nested child/m,
  );
});

test("Preview and final rendering preserve multiple blank lines between blocks", () => {
  const markdown = "# Title\n\n\nParagraph\n\n\n> Quote";
  assert.equal(
    renderMarkdownPreviewText(markdown),
    "Title\n\n\nParagraph\n\n\n> Quote",
  );
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.equal(chunks.length, 1);
  assert.match(
    chunks[0]?.text ?? "",
    /<b>Title<\/b>\n\n\nParagraph\n\n\n<blockquote>Quote<\/blockquote>/,
  );
});

test("Rendering preserves original blank-line spacing across block transitions", () => {
  const cases = [
    {
      markdown: "Para\n\n\n```ts\nconst x = 1\n```",
      finalText:
        'Para\n\n\n<pre><code class="language-ts">const x = 1</code></pre>',
      previewText:
        'Para\n\n\n<pre><code class="language-ts">const x = 1</code></pre>',
    },
    {
      markdown: "```ts\nconst x = 1\n```\n\n\nPara",
      finalText:
        '<pre><code class="language-ts">const x = 1</code></pre>\n\n\nPara',
      previewText:
        '<pre><code class="language-ts">const x = 1</code></pre>\n\n\nPara',
    },
    {
      markdown: "Para\n\n\n- item",
      finalText: "Para\n\n\n<code>-</code> item",
      previewText: "Para\n\n\n- item",
    },
    {
      markdown: "Para\n\n\n> Quote",
      finalText: "Para\n\n\n<blockquote>Quote</blockquote>",
      previewText: "Para\n\n\n&gt; Quote",
    },
  ];
  for (const testCase of cases) {
    const finalChunks = renderTelegramMessage(testCase.markdown, {
      mode: "markdown",
    });
    assert.equal(finalChunks.length, 1);
    assert.equal(finalChunks[0]?.text ?? "", testCase.finalText);
    const preview = buildTelegramPreviewSnapshot({
      state: { pendingText: testCase.markdown, lastSentText: "" },
      maxMessageLength: MAX_MESSAGE_LENGTH,
      renderPreviewText: renderMarkdownPreviewText,
      renderTelegramMessage: renderTelegramMessage,
    });
    assert.equal(preview?.text ?? "", testCase.previewText);
  }
});

test("Headings keep visible spacing before following code blocks even without source blank lines", () => {
  const markdown = "### Title\n```ts\nconst x = 1\n```";
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.equal(chunks.length, 1);
  assert.match(
    chunks[0]?.text ?? "",
    /<b>Title<\/b>\n\n<pre><code class="language-ts">const x = 1<\/code><\/pre>/,
  );
});

test("Standalone checkbox-looking prose stays literal outside task lists", () => {
  const markdown = "Use [ ] as a placeholder and keep [x] literal";
  assert.equal(renderMarkdownPreviewText(markdown), markdown);
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.equal(chunks.length, 1);
  assert.equal((chunks[0]?.text ?? "").includes("<code>[ ]</code>"), false);
  assert.equal((chunks[0]?.text ?? "").includes("<code>[x]</code>"), false);
  assert.match(chunks[0]?.text ?? "", /Use \[ \] as a placeholder/);
  assert.match(chunks[0]?.text ?? "", /keep \[x\] literal/);
});

test("Nested blockquotes flatten into one Telegram blockquote with indentation", () => {
  const chunks = renderTelegramMessage("> outer\n>> inner\n>>> deepest", {
    mode: "markdown",
  });
  assert.equal(chunks.length, 1);
  assert.equal((chunks[0]?.text.match(/<blockquote>/g) ?? []).length, 1);
  assert.equal((chunks[0]?.text.match(/<\/blockquote>/g) ?? []).length, 1);
  assert.match(chunks[0]?.text ?? "", /outer/);
  assert.match(chunks[0]?.text ?? "", /\u00A0\u00A0inner/);
  assert.match(chunks[0]?.text ?? "", /\u00A0\u00A0\u00A0\u00A0deepest/);
});

test("Markdown tables render as literal monospace blocks without outer side borders", () => {
  const chunks = renderTelegramMessage(
    "| Name | Value |\n| --- | --- |\n| **x** | `y` |",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /<pre><code class="language-markdown">/);
  assert.equal((chunks[0]?.text ?? "").includes("<b>x</b>"), false);
  assert.match(chunks[0]?.text ?? "", /Name\s+\|\s+Value/);
  assert.match(chunks[0]?.text ?? "", /x\s+\|\s+y/);
  assert.equal((chunks[0]?.text ?? "").includes("| Name |"), false);
  assert.equal((chunks[0]?.text ?? "").includes("| x |"), false);
});

test("Markdown table padding uses emoji grapheme display width", () => {
  const chunks = renderTelegramMessage(
    "| Icon | Name |\n| --- | --- |\n| 👩‍💻 | dev |\n| ✅ | done |\n| 1️⃣ | key |",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /Icon \| Name/);
  assert.match(chunks[0]?.text ?? "", /👩‍💻 {3}\| dev /u);
  assert.match(chunks[0]?.text ?? "", /✅ {3}\| done/u);
  assert.match(chunks[0]?.text ?? "", /1️⃣ {3}\| key /u);
});

test("Markdown table padding handles CJK and combining marks", () => {
  const chunks = renderTelegramMessage(
    "| Word | Note |\n| --- | --- |\n| é | acute |\n| 東京 | city |",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /Word \| Note /);
  assert.match(chunks[0]?.text ?? "", /é {4}\| acute/u);
  assert.match(chunks[0]?.text ?? "", /東京 \| city /u);
});

test("Links, code spans, and underscore-heavy text coexist safely", () => {
  const chunks = renderTelegramMessage(
    "See [docs](https://example.com), run `foo_bar()` and keep foo_bar.txt literal",
    { mode: "markdown" },
  );
  assert.equal(chunks.length, 1);
  assert.match(
    chunks[0]?.text ?? "",
    /<a href="https:\/\/example.com">docs<\/a>/,
  );
  assert.match(chunks[0]?.text ?? "", /<code>foo_bar\(\)<\/code>/);
  assert.equal((chunks[0]?.text ?? "").includes("<i>bar</i>"), false);
});

test("HTML attributes are escaped or sanitized in generated Telegram markup", () => {
  const linkChunks = renderTelegramMessage(
    '[quoted](<https://example.com/"quoted">)',
    { mode: "markdown" },
  );
  assert.match(
    linkChunks[0]?.text ?? "",
    /<a href="https:\/\/example.com\/&quot;quoted&quot;">quoted<\/a>/,
  );
  const codeChunks = renderTelegramMessage(
    '```ts"onclick=bad\nconst value = 1;\n```',
    { mode: "markdown" },
  );
  assert.match(
    codeChunks[0]?.text ?? "",
    /<pre><code class="language-tsonclickbad">/,
  );
  assert.equal((codeChunks[0]?.text ?? "").includes('"onclick'), false);
});

test("HTML mode chunks long messages below Telegram limits", () => {
  const chunks = renderTelegramMessage("x".repeat(5000), {
    mode: "html",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(chunk.parseMode, "HTML");
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
  }
});

test("HTML mode keeps tags balanced across long chunk boundaries", () => {
  const chunks = renderTelegramMessage(
    `<blockquote><b>${"x".repeat(5000)}</b></blockquote>`,
    { mode: "html" },
  );
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(chunk.parseMode, "HTML");
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<blockquote>/g) ?? []).length,
      (chunk.text.match(/<\/blockquote>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<b>/g) ?? []).length,
      (chunk.text.match(/<\/b>/g) ?? []).length,
    );
  }
});

test("Links degrade or normalize safely across supported and unsupported markdown forms", () => {
  const markdown = [
    "[**Bold** label](https://example.com/path)",
    "[Docs](https://example.com/a_(b))",
    '[Title](https://example.com/path "Tooltip")',
    "[Relative](./docs/README.md)",
    "[Ref][docs]",
    "",
    "[docs]: https://example.com/ref",
    "",
    "Footnote[^1]",
    "",
    "[^1]: Footnote body",
  ].join("\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.equal(chunks.length, 1);
  assert.match(
    chunks[0]?.text ?? "",
    /<a href="https:\/\/example.com\/path">Bold label<\/a>/,
  );
  assert.match(
    chunks[0]?.text ?? "",
    /<a href="https:\/\/example.com\/a_\(b\)">Docs<\/a>/,
  );
  assert.match(
    chunks[0]?.text ?? "",
    /<a href="https:\/\/example.com\/path">Title<\/a>/,
  );
  assert.equal(
    (chunks[0]?.text ?? "").includes('<a href="./docs/README.md">'),
    false,
  );
  assert.match(chunks[0]?.text ?? "", /Relative/);
  assert.equal(
    (chunks[0]?.text ?? "").includes('<a href="https://example.com/ref">'),
    false,
  );
  assert.match(chunks[0]?.text ?? "", /\[Ref\]\[docs\]/);
  assert.match(chunks[0]?.text ?? "", /Footnote\[\^1\]/);
  assert.match(chunks[0]?.text ?? "", /\[\^1\]: Footnote body/);
});

test("Long quoted blocks stay chunked with balanced blockquote tags", () => {
  const markdown = Array.from(
    { length: 500 },
    (_, index) => `> quoted **${index}** line`,
  ).join("\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<blockquote>/g) ?? []).length,
      (chunk.text.match(/<\/blockquote>/g) ?? []).length,
    );
  }
});

test("Long markdown replies stay chunked below Telegram limits", () => {
  const markdown = Array.from(
    { length: 600 },
    (_, index) => `- item **${index}**`,
  ).join("\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<b>/g) ?? []).length,
      (chunk.text.match(/<\/b>/g) ?? []).length,
    );
  }
});

test("Long mixed links and code spans stay chunked with balanced inline tags", () => {
  const markdown = Array.from(
    { length: 450 },
    (_, index) =>
      `Paragraph ${index}: see [docs ${index}](https://example.com/${index}), run \`code_${index}()\`, and keep foo_bar_${index}.txt literal`,
  ).join("\n\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<a /g) ?? []).length,
      (chunk.text.match(/<\/a>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<code>/g) ?? []).length,
      (chunk.text.match(/<\/code>/g) ?? []).length,
    );
    assert.equal((chunk.text ?? "").includes("<i>bar</i>"), false);
  }
});

test("Long multi-block markdown keeps quotes and code fences structurally balanced", () => {
  const markdown = Array.from({ length: 120 }, (_, index) => {
    return [
      `## Section ${index}`,
      `> quoted **${index}** line`,
      `- item ${index}`,
      "```ts",
      `const value_${index} = "**raw**";`,
      "```",
    ].join("\n");
  }).join("\n\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<blockquote>/g) ?? []).length,
      (chunk.text.match(/<\/blockquote>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<pre><code/g) ?? []).length,
      (chunk.text.match(/<\/code><\/pre>/g) ?? []).length,
    );
  }
});

test("Chunked mixed block transitions keep quote and list structure balanced", () => {
  const markdown = Array.from({ length: 260 }, (_, index) => {
    return [
      `> quoted **${index}** intro`,
      `> continuation ${index}`,
      `- item ${index}`,
      `plain paragraph ${index} with [link](https://example.com/${index})`,
    ].join("\n");
  }).join("\n\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<blockquote>/g) ?? []).length,
      (chunk.text.match(/<\/blockquote>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<a /g) ?? []).length,
      (chunk.text.match(/<\/a>/g) ?? []).length,
    );
  }
});

test("Chunked code fence transitions keep code blocks closed before following prose", () => {
  const markdown = Array.from({ length: 220 }, (_, index) => {
    return [
      "```ts",
      `const block_${index} = "value_${index}";`,
      "```",
      `After code **${index}** and \`inline_${index}()\``,
    ].join("\n");
  }).join("\n\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<pre><code/g) ?? []).length,
      (chunk.text.match(/<\/code><\/pre>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<code(?: class="[^"]+")?>/g) ?? []).length,
      (chunk.text.match(/<\/code>/g) ?? []).length,
    );
  }
});

test("Long inline formatting paragraphs stay balanced across chunk boundaries", () => {
  const markdown = Array.from({ length: 500 }, (_, index) => {
    return `Segment ${index} keeps **bold_${index}** with \`code_${index}()\`, [link_${index}](https://example.com/${index}), and foo_bar_${index}.txt literal.`;
  }).join(" ");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<b>/g) ?? []).length,
      (chunk.text.match(/<\/b>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<a /g) ?? []).length,
      (chunk.text.match(/<\/a>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<code>/g) ?? []).length,
      (chunk.text.match(/<\/code>/g) ?? []).length,
    );
    assert.equal(chunk.text.includes("<i>bar</i>"), false);
  }
});

test("Realistic model output fixtures render safely", () => {
  const fixtures = [
    [
      "Here is the migration plan:",
      "",
      "1. [x] Snapshot the database",
      "2. [ ] Apply the patch with `pnpm db:migrate`",
      "3. [ ] Verify [Grafana](https://example.com/dashboards/db)",
      "",
      "> Note: keep `user_id` and `team_id` untouched.",
      "",
      "```sql",
      "ALTER TABLE users ADD COLUMN team_id uuid; -- **literal**",
      "```",
    ].join("\n"),
    [
      "### Comparison",
      "| Option | Pros | Cons |",
      "| --- | --- | --- |",
      "| A | Fast | More foo_bar flags |",
      "| B | Safer | Requires rollback notes |",
      "",
      "Unsupported relative link: [local](./notes.md)",
      "Supported link: [docs](https://example.com/path?q=a_b)",
    ].join("\n"),
    [
      "The JSON payload should stay literal:",
      "",
      "```json",
      '{ "markdown": "**not bold**", "path": "foo_bar/baz" }',
      "```",
      "",
      "Nested quote from model output:",
      "> outer",
      ">> inner with **bold**",
    ].join("\n"),
  ];
  for (const markdown of fixtures) {
    const chunks = renderTelegramMessage(markdown, {
      mode: "markdown",
    });
    assert.ok(chunks.length > 0);
    for (const chunk of chunks) {
      assert.equal(chunk.parseMode, "HTML");
      assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
      assert.equal(
        countMatches(chunk.text, /<a /g),
        countMatches(chunk.text, /<\/a>/g),
      );
      assert.equal(
        countMatches(chunk.text, /<blockquote>/g),
        countMatches(chunk.text, /<\/blockquote>/g),
      );
      assert.equal(
        countMatches(chunk.text, /<pre><code/g),
        countMatches(chunk.text, /<\/code><\/pre>/g),
      );
      assert.equal(chunk.text.includes("<i>bar</i>"), false);
    }
  }
});

test("Chunked list, code, quote, and prose cycles stay balanced across transitions", () => {
  const markdown = Array.from({ length: 180 }, (_, index) => {
    return [
      `- list item **${index}**`,
      "```ts",
      `const cycle_${index} = "value_${index}";`,
      "```",
      `> quoted ${index} with [link](https://example.com/${index})`,
      `Plain paragraph ${index} with \`inline_${index}()\``,
    ].join("\n");
  }).join("\n\n");
  const chunks = renderTelegramMessage(markdown, {
    mode: "markdown",
  });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_MESSAGE_LENGTH);
    assert.equal(
      (chunk.text.match(/<pre><code/g) ?? []).length,
      (chunk.text.match(/<\/code><\/pre>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<blockquote>/g) ?? []).length,
      (chunk.text.match(/<\/blockquote>/g) ?? []).length,
    );
    assert.equal(
      (chunk.text.match(/<a /g) ?? []).length,
      (chunk.text.match(/<\/a>/g) ?? []).length,
    );
  }
});

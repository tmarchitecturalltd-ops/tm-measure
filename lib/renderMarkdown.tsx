/**
 * lib/renderMarkdown.tsx
 *
 * Minimal markdown → JSX renderer for static privacy / support pages.
 *
 * Deliberately tiny — supports just the subset the policies use:
 *   • # / ## / ### headings
 *   • paragraphs
 *   • **bold** and *italic*
 *   • bullet lists
 *   • horizontal rules (---)
 *   • inline `code`
 *
 * No tables, no images, no nested lists, no link parsing beyond a
 * straight `[text](url)`. If we ever need more, swap this for
 * `marked` or `markdown-it`. For policy pages the surface is small
 * enough that hand-rolling avoids a 50 KB dependency.
 */

import type { ReactNode } from "react";

const HEADER_CLASS = "font-headline text-on-surface";

/**
 * Only allow link schemes that cannot execute script.
 *
 * `[text](url)` previously went straight into href, so a
 * `javascript:` or `data:text/html` URL in the markdown would render
 * as a working script link. The policy pages are static files in this
 * repo, so it was not reachable by an outside attacker — but it makes
 * this helper unsafe for any source that isn't fully trusted, and
 * that's an easy assumption for someone to break later.
 *
 * Anything not on the allowlist renders as plain text rather than
 * being silently dropped, so a mistake in a policy page is visible.
 */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  // Relative and anchor links are fine and can't carry a scheme.
  if (/^(\/|#|\.\/|\.\.\/)/.test(url)) return url;
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  return null;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // Order matters: links first (so [text](url) tokens aren't mangled
  // by the bold/italic parsers), then bold, then italic, then code.
  const tokens: ReactNode[] = [];
  let rest = text;
  let idx = 0;
  const push = (node: ReactNode) => {
    tokens.push(<span key={`${keyPrefix}-${idx++}`}>{node}</span>);
  };

  while (rest.length > 0) {
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)/.exec(rest);
    const boldMatch = /^\*\*([^*]+)\*\*/.exec(rest);
    const italicMatch = /^\*([^*]+)\*/.exec(rest);
    const codeMatch = /^`([^`]+)`/.exec(rest);
    if (linkMatch) {
      const href = safeHref(linkMatch[2]);
      push(
        href ? (
          <a href={href} className="text-primary underline" target="_blank" rel="noopener noreferrer">{linkMatch[1]}</a>
        ) : (
          // Disallowed scheme — show the text so the page still reads,
          // but never make it clickable.
          <>{linkMatch[1]}</>
        ),
      );
      rest = rest.slice(linkMatch[0].length);
    } else if (boldMatch) {
      push(<strong>{boldMatch[1]}</strong>);
      rest = rest.slice(boldMatch[0].length);
    } else if (italicMatch) {
      push(<em>{italicMatch[1]}</em>);
      rest = rest.slice(italicMatch[0].length);
    } else if (codeMatch) {
      push(<code className="rounded bg-surface-container-high px-1 py-0.5 font-mono text-xs">{codeMatch[1]}</code>);
      rest = rest.slice(codeMatch[0].length);
    } else {
      const cut = rest.search(/[\\[*`]/);
      if (cut === -1) {
        push(rest);
        break;
      } else if (cut === 0) {
        // Stray markup char — emit and keep going.
        push(rest[0]);
        rest = rest.slice(1);
      } else {
        push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
    }
  }
  return tokens;
}

export function renderMarkdown(source: string): ReactNode {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  let blockIdx = 0;

  const flushParagraph = () => {
    if (!para.length) return;
    const text = para.join(" ").trim();
    if (text) {
      blocks.push(
        <p key={`b${blockIdx++}`} className="my-4 text-sm leading-relaxed text-on-surface">
          {renderInline(text, `b${blockIdx}`)}
        </p>,
      );
    }
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(
      <ul key={`b${blockIdx++}`} className="my-4 space-y-2 pl-5 text-sm leading-relaxed text-on-surface" style={{ listStyleType: "disc" }}>
        {list.map((item, i) => (
          <li key={i}>{renderInline(item, `li${blockIdx}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("# ")) {
      flushParagraph();
      flushList();
      blocks.push(
        <h1 key={`b${blockIdx++}`} className={`${HEADER_CLASS} mt-6 text-3xl`}>
          {renderInline(line.slice(2), `h1-${blockIdx}`)}
        </h1>,
      );
    } else if (line.startsWith("## ")) {
      flushParagraph();
      flushList();
      blocks.push(
        <h2 key={`b${blockIdx++}`} className={`${HEADER_CLASS} mt-8 text-xl`}>
          {renderInline(line.slice(3), `h2-${blockIdx}`)}
        </h2>,
      );
    } else if (line.startsWith("### ")) {
      flushParagraph();
      flushList();
      blocks.push(
        <h3 key={`b${blockIdx++}`} className={`${HEADER_CLASS} mt-6 text-base font-semibold`}>
          {renderInline(line.slice(4), `h3-${blockIdx}`)}
        </h3>,
      );
    } else if (line.startsWith("---")) {
      flushParagraph();
      flushList();
      blocks.push(<hr key={`b${blockIdx++}`} className="my-8 border-outline-variant/30" />);
    } else if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      if (!list) list = [];
      list.push(line.replace(/^[-*]\s+/, ""));
    } else if (line === "") {
      flushParagraph();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushParagraph();
  flushList();

  return <>{blocks}</>;
}

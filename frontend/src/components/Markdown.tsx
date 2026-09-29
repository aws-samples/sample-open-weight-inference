import type { ReactNode } from 'react';
import Box from '@cloudscape-design/components/box';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { brandText } from './BrandName';

/**
 * A deliberately small Markdown renderer for advisor prose.
 *
 * Cloudscape ships no Markdown component, and pulling in a full parser to
 * render model output would mean auditing its sanitisation. This produces
 * React elements only — there is no `dangerouslySetInnerHTML` anywhere, so raw
 * HTML in the model's output is displayed as text and can never execute.
 *
 * Supported: headings, paragraphs, bullet and ordered lists, fenced code,
 * blockquotes, tables, horizontal rules, bold, italic, inline code, and links. Anything else falls
 * through as plain text rather than being dropped.
 */

type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/** Only these schemes may become a clickable link. */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  // Anything else — notably `javascript:` and `data:` — is not linkified.
  return null;
}

const INLINE_PATTERN =
  /(\[[^\]\n]*\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(`[^`\n]+`)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let rest = source;

  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      out.push({ kind: 'text', text: rest });
      break;
    }
    if (match.index > 0) {
      out.push({ kind: 'text', text: rest.slice(0, match.index) });
    }
    const token = match[0];

    if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]\n]*)\]\(([^)\s]+)\)$/.exec(token);
      const href = linkMatch ? safeHref(linkMatch[2]) : null;
      if (linkMatch && href) {
        out.push({ kind: 'link', text: linkMatch[1] || href, href });
      } else {
        // An unsafe or malformed link stays literal text.
        out.push({ kind: 'text', text: token });
      }
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push({ kind: 'bold', text: token.slice(2, -2) });
    } else if (token.startsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) });
    } else {
      out.push({ kind: 'italic', text: token.slice(1, -1) });
    }
    rest = rest.slice(match.index + token.length);
  }

  return out.filter((node) => node.kind !== 'text' || node.text !== '');
}

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      case 'bold':
        return (
          <Box key={key} variant="strong" display="inline">
            {brandText(node.text)}
          </Box>
        );
      case 'italic':
        return <em key={key}>{brandText(node.text)}</em>;
      case 'code':
        return (
          <Box key={key} variant="code" display="inline">
            {node.text}
          </Box>
        );
      case 'link':
        return (
          <Link
            key={key}
            href={node.href}
            external
            externalIconAriaLabel="Opens in a new tab"
          >
            {brandText(node.text)}
          </Link>
        );
      case 'text':
      default:
        return <span key={key}>{brandText(node.text)}</span>;
    }
  });
}

type Block =
  | { kind: 'heading'; level: 2 | 3 | 4 | 5; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'ordered'; start: number; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'rule' };

/** Split table cells without turning escaped or inline-code pipes into columns. */
function tableCells(line: string): string[] | null {
  const cells: string[] = [];
  let cell = '';
  let ticks = 0;
  let hasPipe = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && ['|', '\\'].includes(line[i + 1])) {
      cell += line[++i];
    } else if (line[i] === '`') {
      let end = i + 1;
      while (line[end] === '`') end += 1;
      const count = end - i;
      if (ticks === 0) ticks = count;
      else if (ticks === count) ticks = 0;
      cell += line.slice(i, end);
      i = end - 1;
    } else if (line[i] === '|' && ticks === 0) {
      cells.push(cell.trim());
      cell = '';
      hasPipe = true;
    } else {
      cell += line[i];
    }
  }
  if (!hasPipe) return null;
  cells.push(cell.trim());
  if (cells[0] === '' && line.trimStart().startsWith('|')) cells.shift();
  if (cells[cells.length - 1] === '' && line.trimEnd().endsWith('|')) cells.pop();
  return cells;
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  const flushParagraph = (buffer: string[]) => {
    if (buffer.length > 0) {
      blocks.push({ kind: 'paragraph', text: buffer.join(' ').trim() });
      buffer.length = 0;
    }
  };

  const paragraph: string[] = [];

  while (index < lines.length) {
    const line = lines[index];

    // Fenced code: consumed verbatim, so nothing inside is interpreted.
    if (/^\s*```/.test(line)) {
      flushParagraph(paragraph);
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const headers = tableCells(line);
    const separator = index + 1 < lines.length ? tableCells(lines[index + 1]) : null;
    if (headers?.length && separator?.length === headers.length &&
        separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
      flushParagraph(paragraph);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length) {
        const cells = tableCells(lines[index]);
        if (!cells || cells.length !== headers.length) break;
        rows.push(cells);
        index += 1;
      }
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(paragraph);
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const heading = /^\s{0,3}(#{1,5})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      // Advisor prose sits inside a chat bubble, so its headings start at h4
      // to stay below the page and section headings around it.
      const depth = Math.min(5, Math.max(2, heading[1].length + 1)) as
        | 2
        | 3
        | 4
        | 5;
      blocks.push({ kind: 'heading', level: depth, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      flushParagraph(paragraph);
      const body: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: body.join(' ').trim() });
      continue;
    }

    if (/^\s{0,3}[-*+]\s+/.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (index < lines.length && /^\s{0,3}[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s{0,3}[-*+]\s+/, '').trim());
        index += 1;
      }
      blocks.push({ kind: 'bullets', items });
      continue;
    }

    const ordered = /^\s{0,3}(\d{1,9})[.)]\s+/.exec(line);
    if (ordered) {
      flushParagraph(paragraph);
      const start = Number(ordered[1]);
      const items: string[] = [];
      const marker = /^\s{0,3}\d{1,9}[.)]\s+/;
      while (index < lines.length && marker.test(lines[index])) {
        items.push(lines[index].replace(marker, '').trim());
        index += 1;
        // Blank lines between top-level items do not restart the numbering.
        let next = index;
        while (next < lines.length && lines[next].trim() === '') next += 1;
        if (next < lines.length && marker.test(lines[next])) index = next;
      }
      blocks.push({ kind: 'ordered', start, items });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flushParagraph(paragraph);
  return blocks;
}

/** Render advisor Markdown as Cloudscape-styled React elements. */
export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source);

  if (blocks.length === 0) {
    return (
      <Box variant="p" color="text-body-secondary">
        The advisor returned an empty reply.
      </Box>
    );
  }

  return (
    <SpaceBetween size="s">
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case 'heading':
            return (
              <Box
                key={key}
                variant={`h${block.level}` as 'h2' | 'h3' | 'h4' | 'h5'}
              >
                {renderInline(parseInline(block.text), key)}
              </Box>
            );
          case 'bullets':
            return (
              <ul key={key} style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>
                    {renderInline(parseInline(item), `${key}-${itemIndex}`)}
                  </li>
                ))}
              </ul>
            );
          case 'ordered':
            return (
              <ol key={key} start={block.start} style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>
                    {renderInline(parseInline(item), `${key}-${itemIndex}`)}
                  </li>
                ))}
              </ol>
            );
          case 'code':
            return (
              <Box key={key} variant="code">
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                  {block.text}
                </pre>
              </Box>
            );
          case 'table':
            return (
              <Table<string[]>
                key={key}
                variant="embedded"
                wrapLines
                ariaLabels={{ tableLabel: 'Advisor comparison' }}
                columnDefinitions={block.headers.map((header, column) => ({
                  id: `column-${column}`,
                  minWidth: 140,
                  header: renderInline(parseInline(header), `${key}-header-${column}`),
                  cell: (row: string[]) => renderInline(parseInline(row[column]), `${key}-cell-${column}`),
                }))}
                items={block.rows}
              />
            );
          case 'rule':
            return <hr key={key} style={{ border: 0, borderTop: '1px solid', opacity: 0.2, margin: 0 }} />;
          case 'quote':
            return (
              <Box key={key} variant="p" color="text-body-secondary">
                {renderInline(parseInline(block.text), key)}
              </Box>
            );
          case 'paragraph':
          default:
            return (
              <Box key={key} variant="p">
                {renderInline(parseInline(block.text), key)}
              </Box>
            );
        }
      })}
    </SpaceBetween>
  );
}

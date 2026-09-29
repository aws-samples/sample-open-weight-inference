import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Markdown, parseBlocks, parseInline } from '../Markdown';

describe('Markdown safety', () => {
  it('never injects raw HTML — a script tag is shown as text', () => {
    const { container } = render(
      <Markdown source={'Hello <script>alert(1)</script> world'} />
    );
    // The tag is inert text, not a node.
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('does not render an img tag from HTML in the source', () => {
    const { container } = render(
      <Markdown source={'<img src=x onerror="alert(1)">'} />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
  });

  it('refuses to linkify a javascript: URL, leaving it as text', () => {
    const { container } = render(
      // eslint-disable-next-line no-script-url
      <Markdown source={'[click me](javascript:alert(1))'} />
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('[click me]');
  });

  it('refuses to linkify a data: URL', () => {
    const { container } = render(
      <Markdown source={'[x](data:text/html;base64,PHNjcmlwdD4=)'} />
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('linkifies an https URL and marks it external', () => {
    render(<Markdown source={'See [the docs](https://example.test/a).'} />);
    const link = screen.getByText('the docs').closest('a');
    expect(link).toHaveAttribute('href', 'https://example.test/a');
    expect(link).toHaveAttribute('target', '_blank');
  });
});

describe('Markdown inline parsing', () => {
  it('renders bold, italic and inline code', () => {
    render(<Markdown source={'A **bold** and *italic* and `code` run.'} />);
    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(screen.getByText('italic')).toBeInTheDocument();
    expect(screen.getByText('code')).toBeInTheDocument();
    // No literal markers survive.
    expect(screen.queryByText(/\*\*bold\*\*/)).toBeNull();
  });

  it('parses a bold run into a bold node', () => {
    expect(parseInline('a **b** c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' c' },
    ]);
  });

  it('leaves an unmatched asterisk alone rather than mangling the text', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([
      { kind: 'text', text: '2 * 3 = 6' },
    ]);
  });
});

describe('Markdown block parsing', () => {
  it('recognises headings, lists, code fences and quotes', () => {
    const blocks = parseBlocks(
      [
        '## Heading',
        '',
        'A paragraph.',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
        '',
        '```',
        'raw **not bold**',
        '```',
        '',
        '> quoted',
      ].join('\n')
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'bullets',
      'ordered',
      'code',
      'quote',
    ]);
  });

  it('keeps fenced code verbatim, without interpreting markup inside it', () => {
    render(<Markdown source={'```\na **b** c\n```'} />);
    expect(screen.getByText('a **b** c')).toBeInTheDocument();
  });

  it('renders list items', () => {
    render(<Markdown source={'- Active CMU-minutes\n- Idle for 66 hours'} />);
    expect(screen.getByText('Active CMU-minutes')).toBeInTheDocument();
    expect(screen.getByText('Idle for 66 hours')).toBeInTheDocument();
  });

  it('demotes advisor headings so they sit below the page hierarchy', () => {
    // A `#` in a chat bubble must not become an h1 competing with the page.
    const blocks = parseBlocks('# Top level');
    expect(blocks[0]).toEqual({ kind: 'heading', level: 2, text: 'Top level' });
  });

  it('explains an empty reply rather than rendering nothing', () => {
    render(<Markdown source={'   '} />);
    expect(
      screen.getByText('The advisor returned an empty reply.')
    ).toBeInTheDocument();
  });
});


describe('Advisor comparison tables', () => {
  const comparison = `| Component | Basis |
| --- | --- |
| **Resident weights** | Total parameters |
| Attention cache | Architecture and concurrency |`;

  it('renders the real sizing answer as an accessible table rather than pipe-delimited prose', () => {
    render(<Markdown source={comparison} />);
    const table = screen.getByRole('table', { name: 'Advisor comparison' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(2);
    expect(within(table).getByRole('cell', { name: 'Resident weights' })).toBeVisible();
    expect(within(table).getByRole('cell', { name: 'Architecture and concurrency' })).toBeVisible();
    expect(table.textContent).not.toContain('| ---');
  });

  it('preserves escaped and inline-code pipes without creating extra cells', () => {
    const source = ['| Example | Meaning |', '| :--- | ---: |', '| a\\|b | `left|right` |'].join('\n');
    expect(parseBlocks(source)).toEqual([{
      kind: 'table', headers: ['Example', 'Meaning'], rows: [['a|b', '`left|right`']],
    }]);
  });

  it('keeps partial streamed headers visible until a complete table delimiter arrives', () => {
    const { rerender } = render(<Markdown source={`| Component | Basis |
| --`} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/Component/)).toBeInTheDocument();
    rerender(<Markdown source={comparison} />);
    expect(screen.getByRole('table', { name: 'Advisor comparison' })).toBeInTheDocument();
  });

  it('does not interpret table cells as executable HTML or unsafe links', () => {
    const { container } = render(<Markdown source={`| Field | Value |
| --- | --- |
| <img src=x onerror=alert(1)> | [run](javascript:alert) |`} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('preserves pipe text inside fenced code and malformed rows following a table', () => {
    const source = ['```', comparison, '```', '', comparison, '| extra | cells | stay |'].join('\n');
    const blocks = parseBlocks(source);
    expect(blocks[0]).toEqual({ kind: 'code', text: comparison });
    expect(blocks[1].kind).toBe('table');
    expect(blocks[2]).toEqual({ kind: 'paragraph', text: '| extra | cells | stay |' });
  });

  it('renders a separator as a rule without stealing a table delimiter', () => {
    render(<Markdown source={[comparison, '', '---', '', 'Next check.'].join('\n')} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getByText('Next check.')).toBeInTheDocument();
  });
});


describe('Numbered Advisor procedures', () => {
  it('keeps blank-separated steps in one ordered list', () => {
    render(<Markdown source={'1. Check runtime support.\n\n2. Measure a job.\n\n3. Compare its full cost.'} />);
    const list = screen.getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(list).toHaveAttribute('start', '1');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });

  it('preserves a continuation start without absorbing a following paragraph or bullets', () => {
    render(<Markdown source={'4. Record the result.\n\n5. Review the evidence.\n\nOpen questions:\n\n- Deadline'} />);
    const lists = screen.getAllByRole('list');
    expect(lists[0]).toHaveAttribute('start', '4');
    expect(within(lists[0]).getAllByRole('listitem')).toHaveLength(2);
    expect(lists[1].tagName).toBe('UL');
    expect(screen.getByText('Open questions:')).toBeVisible();
  });
});

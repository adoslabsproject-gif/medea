/**
 * Mini renderer Markdown → React (zero dipendenze, sufficiente per risposte AI).
 * Gestisce: heading, bold, italic, inline code, code blocks, liste, link, blockquote, hr.
 * Niente HTML arbitrario in output: tutto via React.createElement.
 */
import { type ReactNode } from 'react';

type Block =
  | { type: 'h'; level: number; children: Inline[] }
  | { type: 'p'; children: Inline[] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; items: Inline[][] }
  | { type: 'pre'; lang: string | null; text: string }
  | { type: 'quote'; children: Inline[] }
  | { type: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { type: 'hr' };

type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };

function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  const push = (n: Inline) => {
    out.push(n);
  };
  while (i < line.length) {
    if (line.startsWith('**', i)) {
      const end = line.indexOf('**', i + 2);
      if (end > i + 2) {
        push({ type: 'bold', children: parseInline(line.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (line[i] === '*' && line[i + 1] !== ' ') {
      const end = line.indexOf('*', i + 1);
      if (end > i + 1) {
        push({ type: 'em', children: parseInline(line.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1);
      if (end > i + 1) {
        push({ type: 'code', value: line.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (line[i] === '[') {
      const close = line.indexOf(']', i);
      if (close > 0 && line[close + 1] === '(') {
        const closeUrl = line.indexOf(')', close + 1);
        if (closeUrl > 0) {
          const txt = line.slice(i + 1, close);
          const url = line.slice(close + 2, closeUrl);
          push({ type: 'link', href: url, children: parseInline(txt) });
          i = closeUrl + 1;
          continue;
        }
      }
    }
    // testo "normale" fino al prossimo carattere markdown
    const nextIdx = (() => {
      let m = Number.POSITIVE_INFINITY;
      for (const ch of ['**', '*', '`', '[']) {
        const k = line.indexOf(ch, i);
        if (k >= 0 && k < m) m = k;
      }
      return m === Number.POSITIVE_INFINITY ? line.length : m;
    })();
    push({ type: 'text', value: line.slice(i, Math.max(nextIdx, i + 1)) });
    i = Math.max(nextIdx, i + 1);
  }
  return out;
}

/** Riga separatrice di una tabella GFM: `|---|:--:|` (almeno una cella). */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|') || !t.includes('-')) return false;
  return t
    .replace(/^\||\|$/g, '')
    .split('|')
    .every((cell) => /^\s*:?-{1,}:?\s*$/.test(cell));
}

/** Celle di una riga di tabella, senza le pipe di bordo. */
function splitRow(line: string): Inline[][] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => parseInline(cell.trim()));
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || null;
      let j = i + 1;
      const buf: string[] = [];
      while (j < lines.length && !(lines[j] ?? '').startsWith('```')) {
        buf.push(lines[j] ?? '');
        j++;
      }
      out.push({ type: 'pre', lang, text: buf.join('\n') });
      i = j + 1;
      continue;
    }
    // Tabella GFM: riga di intestazione + riga separatrice |---|---|
    if (line.includes('|') && isTableSeparator(lines[i + 1] ?? '')) {
      const head = splitRow(line);
      const rows: Inline[][][] = [];
      let j = i + 2;
      while (j < lines.length && (lines[j] ?? '').includes('|') && (lines[j] ?? '').trim() !== '') {
        rows.push(splitRow(lines[j] ?? ''));
        j++;
      }
      out.push({ type: 'table', head, rows });
      i = j;
      continue;
    }
    const hMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hMatch) {
      out.push({ type: 'h', level: hMatch[1]!.length, children: parseInline(hMatch[2]!) });
      i++;
      continue;
    }
    if (line.startsWith('> ')) {
      const buf: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('> ')) {
        buf.push((lines[i] ?? '').slice(2));
        i++;
      }
      out.push({ type: 'quote', children: parseInline(buf.join(' ')) });
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i] ?? '')) {
        const item = (lines[i] ?? '').replace(/^\s*[-*]\s/, '');
        items.push(parseInline(item));
        i++;
      }
      out.push({ type: 'ul', items });
      continue;
    }
    if (/^\s*\d+\.\s/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i] ?? '')) {
        const item = (lines[i] ?? '').replace(/^\s*\d+\.\s/, '');
        items.push(parseInline(item));
        i++;
      }
      out.push({ type: 'ol', items });
      continue;
    }
    if (line.trim() === '---' || line.trim() === '***') {
      out.push({ type: 'hr' });
      i++;
      continue;
    }
    // paragraph: aggrega righe fino a riga vuota
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(#|>|\s*[-*]\s|\s*\d+\.\s|```)/.test(lines[i] ?? '')
    ) {
      buf.push(lines[i] ?? '');
      i++;
    }
    out.push({ type: 'p', children: parseInline(buf.join(' ')) });
  }
  return out;
}

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return <span key={i}>{n.value}</span>;
      case 'code':
        return <code key={i}>{n.value}</code>;
      case 'bold':
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(n.children)}</em>;
      case 'br':
        return <br key={i} />;
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noreferrer">
            {renderInline(n.children)}
          </a>
        );
    }
  });
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'h': {
            const H = `h${b.level.toString()}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
            return <H key={i}>{renderInline(b.children)}</H>;
          }
          case 'p':
            return <p key={i}>{renderInline(b.children)}</p>;
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            );
          case 'pre':
            return (
              <pre key={i} data-lang={b.lang ?? ''}>
                <code>{b.text}</code>
              </pre>
            );
          case 'quote':
            return <blockquote key={i}>{renderInline(b.children)}</blockquote>;
          case 'table':
            return (
              <div key={i} className="md-tableWrap">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j}>{renderInline(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((c, k) => (
                          <td key={k}>{renderInline(c)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={i} />;
        }
      })}
    </div>
  );
}

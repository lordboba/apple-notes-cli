// ANSI escape codes and text-measurement helpers for the TUI.

export const altOn = '\x1b[?1049h\x1b[?25l'; // alt screen + hide cursor
export const altOff = '\x1b[?1049l\x1b[?25h'; // restore screen + show cursor
export const mouseOn = '\x1b[?1000h\x1b[?1006h'; // click + wheel reporting (SGR)
export const mouseOff = '\x1b[?1006l\x1b[?1000l';
export const home = '\x1b[H';
export const clearBelow = '\x1b[0J';
export const clearLine = '\x1b[K';

export const bold = (s) => `\x1b[1m${s}\x1b[22m`;
export const dim = (s) => `\x1b[2m${s}\x1b[22m`;

const rgb = (r, g, b) => (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
export const accent = rgb(215, 119, 87); // coral, à la Claude Code
export const grey = rgb(150, 148, 145);

// Approximate display width of a code point (wide CJK/emoji = 2, marks = 0).
function charWidth(cp) {
  if (cp === 0x200d || cp === 0xfe0f || (cp >= 0x300 && cp <= 0x36f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf)
  ) {
    return 2;
  }
  return 1;
}

export function strWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

export function truncate(s, width) {
  if (width <= 0) return '';
  if (strWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function padEnd(s, width) {
  const pad = width - strWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

// Truncates and pads plain text to an exact width, then optionally styles it.
export function padRowPlain(s, width, styleFn) {
  const text = padEnd(truncate(s, width), width);
  return styleFn ? styleFn(text) : text;
}

// Word-wraps plain text to a given display width, hard-breaking long words.
export function wrap(text, width) {
  const out = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\t/g, '    ');
    if (strWidth(line) <= width) {
      out.push(line);
      continue;
    }
    let cur = '';
    for (const word of line.split(' ')) {
      const candidate = cur ? cur + ' ' + word : word;
      if (strWidth(candidate) <= width) {
        cur = candidate;
        continue;
      }
      if (cur) out.push(cur);
      let rest = word;
      while (strWidth(rest) > width) {
        let piece = '';
        let pw = 0;
        for (const ch of rest) {
          const cw = charWidth(ch.codePointAt(0));
          if (pw + cw > width) break;
          piece += ch;
          pw += cw;
        }
        out.push(piece);
        rest = rest.slice(piece.length);
      }
      cur = rest;
    }
    out.push(cur);
  }
  return out;
}

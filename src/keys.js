// Raw stdin parsing and keymap resolution (hybrid / vim / emacs + user overrides).

// Turns a raw stdin string into a list of key names like:
// 'a', 'G', 'ctrl+d', 'meta+v', 'up', 'pagedown', 'enter', 'escape', 'space'.
export function parseInput(str) {
  const keys = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\x1b') {
      const next = str[i + 1];
      if (next === '[' || next === 'O') {
        let j = i + 2;
        let seq = '';
        while (j < str.length && !/[A-Za-z~]/.test(str[j])) {
          seq += str[j];
          j++;
        }
        const full = seq + (str[j] || '');
        const map = {
          A: 'up', B: 'down', C: 'right', D: 'left',
          H: 'home', F: 'end', Z: 'shift+tab',
          '1~': 'home', '3~': 'delete', '4~': 'end',
          '5~': 'pageup', '6~': 'pagedown',
        };
        if (map[full]) keys.push(map[full]);
        i = j + 1;
      } else if (next !== undefined) {
        keys.push('meta+' + next);
        i += 2;
      } else {
        keys.push('escape');
        i += 1;
      }
    } else if (ch === '\r' || ch === '\n') {
      keys.push('enter');
      i++;
    } else if (ch === '\t') {
      keys.push('tab');
      i++;
    } else if (ch === '\x7f' || ch === '\b') {
      keys.push('backspace');
      i++;
    } else if (ch === ' ') {
      keys.push('space');
      i++;
    } else {
      const code = ch.charCodeAt(0);
      if (code < 32) {
        keys.push('ctrl+' + String.fromCharCode(code + 96));
        i++;
      } else {
        const c = String.fromCodePoint(str.codePointAt(i));
        keys.push(c);
        i += c.length;
      }
    }
  }
  return keys;
}

// Bindings active in every keymap. Arrow keys always work.
const COMMON = {
  up: ['up'],
  down: ['down'],
  pageUp: ['pageup'],
  pageDown: ['pagedown', 'space'],
  top: ['home'],
  bottom: ['end'],
  open: ['enter'],
  back: ['escape'],
  prev: ['left'],
  next: ['right'],
  quit: ['q', 'ctrl+c'],
  help: ['?'],
  refresh: ['r'],
  search: ['/'],
  settings: ['s'],
};

const VIM = {
  down: ['j'],
  up: ['k'],
  pageDown: ['ctrl+d', 'ctrl+f'],
  pageUp: ['ctrl+u', 'ctrl+b'],
  top: ['g g'], // chord: g then g
  bottom: ['G'],
  prev: ['h'],
  next: ['l'],
};

const EMACS = {
  down: ['ctrl+n'],
  up: ['ctrl+p'],
  pageDown: ['ctrl+v'],
  pageUp: ['meta+v'],
  top: ['meta+<'],
  bottom: ['meta+>'],
  back: ['ctrl+g'],
};

// Merges COMMON + preset(s) + user overrides into { action: [keys...] }.
export function effectiveBindings(config) {
  const sets = [COMMON];
  if (config.keymap === 'vim' || config.keymap === 'hybrid') sets.push(VIM);
  if (config.keymap === 'emacs' || config.keymap === 'hybrid') sets.push(EMACS);
  const map = {};
  for (const set of sets) {
    for (const [action, keys] of Object.entries(set)) {
      map[action] = [...(map[action] || []), ...keys];
    }
  }
  for (const [action, keys] of Object.entries(config.keys || {})) {
    const extra = Array.isArray(keys) ? keys : [keys];
    map[action] = [...extra, ...(map[action] || [])];
  }
  return map;
}

// Resolves a key press to an action, tracking two-key chords like 'g g'.
// Returns { action, pending } — pending is the chord prefix awaiting its
// second key, if any.
export function actionFor(bindings, key, pending) {
  if (pending) {
    const combo = pending + ' ' + key;
    for (const [action, keys] of Object.entries(bindings)) {
      if (keys.includes(combo)) return { action, pending: null };
    }
  }
  for (const keys of Object.values(bindings)) {
    for (const k of keys) {
      if (k.startsWith(key + ' ')) return { action: null, pending: key };
    }
  }
  for (const [action, keys] of Object.entries(bindings)) {
    if (keys.includes(key)) return { action, pending: null };
  }
  return { action: null, pending: null };
}

const KEY_LABELS = {
  up: '↑', down: '↓', left: '←', right: '→',
  enter: '↵', escape: 'esc', space: 'space',
  pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End',
  backspace: '⌫',
};

export function prettyKey(key) {
  return key
    .split(' ')
    .map((part) => {
      if (KEY_LABELS[part]) return KEY_LABELS[part];
      if (part.startsWith('ctrl+')) return 'Ctrl-' + part.slice(5);
      if (part.startsWith('meta+')) return 'Alt-' + part.slice(5);
      return part;
    })
    .join(' ');
}

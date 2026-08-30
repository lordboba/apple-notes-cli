// Main TUI: state, key handling, and rendering for all views.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as t from './term.js';
import { loadConfig, saveConfig, configPath } from './config.js';
import { parseInput, effectiveBindings, actionFor, prettyKey } from './keys.js';
import { fetchNoteList, fetchNoteText, openInNotes } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const KEYMAPS = ['hybrid', 'vim', 'emacs'];
const SORTS = ['modified', 'created', 'title'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const LOCKED_TEXT =
  '🔒 This note is locked.\n\n' +
  'macOS only lets Notes.app itself take the password or Touch ID prompt.\n\n' +
  'Press o to open it in Notes.app and unlock it there, then come back\n' +
  'and press r to reload the text.';

const state = {
  config: null,
  bindings: null,
  view: 'list', // list | note | help | settings | error
  returnView: 'list',
  notes: [],
  loading: true,
  error: null,
  sel: 0,
  query: '',
  searching: false,
  digits: '',
  digitTimer: null,
  pending: null, // chord prefix (e.g. 'g')
  note: null,
  noteText: null,
  noteScroll: 0,
  bodyCache: new Map(),
  settingsSel: 0,
  spinner: 0,
  spinTimer: null,
};

export async function run(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return printUsage();
  if (argv.includes('-v') || argv.includes('--version')) return console.log(pkg.version);
  if (argv[0] === 'list' || !process.stdout.isTTY || !process.stdin.isTTY) return plainList();
  startTui();
}

function printUsage() {
  console.log(`notes ${pkg.version} — a terminal UI for Apple Notes

Usage:
  notes           open the interactive UI
  notes list      print all notes as plain text
  notes --help    show this help

Config: ${configPath}
Keys:   press ? inside the UI for keybindings`);
}

async function plainList() {
  const config = loadConfig();
  const notes = sorted(await fetchNoteList(), config.sort);
  const folderW = Math.min(20, Math.max(5, ...notes.map((n) => n.folder.length)));
  for (const n of notes) {
    console.log(`${fmtDate(n.modified).padEnd(13)} ${n.folder.padEnd(folderW)}  ${n.locked ? '🔒 ' : ''}${n.title}`);
  }
}

// ---------------------------------------------------------------- lifecycle

function startTui() {
  state.config = loadConfig();
  state.bindings = effectiveBindings(state.config);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    for (const key of parseInput(chunk.toString('utf8'))) handleKey(key);
  });
  process.stdout.on('resize', render);
  process.on('uncaughtException', (err) => {
    restoreTerminal();
    console.error(err);
    process.exit(1);
  });

  process.stdout.write(t.altOn);
  render();
  loadList();
}

function restoreTerminal() {
  clearInterval(state.spinTimer);
  clearTimeout(state.digitTimer);
  process.stdout.write(t.altOff);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

function exit() {
  restoreTerminal();
  process.exit(0);
}

function startSpinner() {
  if (state.spinTimer) return;
  state.spinTimer = setInterval(() => {
    state.spinner++;
    render();
  }, 80);
}

function stopSpinner() {
  clearInterval(state.spinTimer);
  state.spinTimer = null;
}

// -------------------------------------------------------------------- data

function sorted(notes, sort) {
  const copy = [...notes];
  if (sort === 'title') copy.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'created') copy.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  else copy.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  return copy;
}

function filtered() {
  if (!state.query) return state.notes;
  const q = state.query.toLowerCase();
  return state.notes.filter((n) => n.title.toLowerCase().includes(q));
}

async function loadList() {
  state.loading = true;
  state.error = null;
  startSpinner();
  try {
    state.notes = sorted(await fetchNoteList(), state.config.sort);
    state.sel = Math.max(0, Math.min(state.sel, filtered().length - 1));
    if (state.view === 'error') state.view = 'list';
  } catch (err) {
    state.error = err.message;
    state.view = 'error';
  } finally {
    state.loading = false;
    stopSpinner();
    render();
  }
}

async function openNote(item) {
  state.view = 'note';
  state.note = item;
  state.noteScroll = 0;
  state.noteText = state.bodyCache.get(item.id) ?? null;
  if (state.noteText !== null) return render();

  startSpinner();
  try {
    const text = await fetchNoteText(item.id);
    if (item.locked && !text.trim()) {
      // Locked notes read as empty until unlocked in Notes.app. Don't cache,
      // so reopening after an unlock picks up the real text.
      if (state.note?.id === item.id) state.noteText = LOCKED_TEXT;
    } else {
      state.bodyCache.set(item.id, text);
      if (state.note?.id === item.id) state.noteText = text;
    }
  } catch (err) {
    if (state.note?.id === item.id) state.noteText = `⚠ Could not load note: ${err.message}`;
  } finally {
    stopSpinner();
    render();
  }
}

// -------------------------------------------------------------------- keys

function handleKey(key) {
  if (key === 'ctrl+c') return exit();
  if (state.searching) return handleSearchKey(key);
  if (state.view === 'list' && /^[0-9]$/.test(key)) return handleDigit(key);

  const { action, pending } = actionFor(state.bindings, key, state.pending);
  state.pending = pending;
  if (!action) return;

  switch (action) {
    case 'quit': return exit();
    case 'help':
      if (state.view === 'help') state.view = state.returnView;
      else { state.returnView = state.view; state.view = 'help'; }
      break;
    case 'settings':
      if (state.view !== 'settings') { state.returnView = state.view === 'help' ? state.returnView : state.view; state.view = 'settings'; state.settingsSel = 0; }
      break;
    case 'refresh':
      if (state.view === 'list' || state.view === 'error') { state.view = 'list'; loadList(); return; }
      if (state.view === 'note' && state.note) { state.bodyCache.delete(state.note.id); openNote(state.note); return; }
      break;
    case 'openExternal': {
      const target = state.view === 'note' ? state.note : state.view === 'list' ? filtered()[state.sel] : null;
      if (target) openInNotes(target.id).catch(() => {});
      break;
    }
    case 'search':
      if (state.view === 'list') { state.searching = true; }
      break;
    case 'back': handleBack(); break;
    default: handleViewAction(action); break;
  }
  render();
}

function handleBack() {
  if (state.view === 'note') { state.view = 'list'; state.note = null; }
  else if (state.view === 'help' || state.view === 'settings') state.view = state.returnView;
  else if (state.view === 'list' && state.query) { state.query = ''; state.sel = 0; }
}

function handleViewAction(action) {
  if (state.view === 'list') return listAction(action);
  if (state.view === 'note') return noteAction(action);
  if (state.view === 'settings') return settingsAction(action);
}

function listAction(action) {
  const items = filtered();
  const page = listPageSize();
  const max = Math.max(0, items.length - 1);
  const clamp = (n) => Math.max(0, Math.min(n, max));
  switch (action) {
    case 'down': state.sel = clamp(state.sel + 1); break;
    case 'up': state.sel = clamp(state.sel - 1); break;
    case 'pageDown': state.sel = clamp(state.sel + page); break;
    case 'pageUp': state.sel = clamp(state.sel - page); break;
    case 'top': state.sel = 0; break;
    case 'bottom': state.sel = max; break;
    case 'open':
      if (state.digits) commitDigits();
      else if (items[state.sel]) openNote(items[state.sel]);
      break;
  }
}

function noteAction(action) {
  const { bodyRows } = layout();
  const total = noteLines().length;
  const maxScroll = Math.max(0, total - bodyRows);
  const clamp = (n) => Math.max(0, Math.min(n, maxScroll));
  switch (action) {
    case 'down': state.noteScroll = clamp(state.noteScroll + 1); break;
    case 'up': state.noteScroll = clamp(state.noteScroll - 1); break;
    case 'pageDown': state.noteScroll = clamp(state.noteScroll + bodyRows); break;
    case 'pageUp': state.noteScroll = clamp(state.noteScroll - bodyRows); break;
    case 'top': state.noteScroll = 0; break;
    case 'bottom': state.noteScroll = maxScroll; break;
    case 'prev': stepNote(-1); break;
    case 'next': stepNote(1); break;
  }
}

function stepNote(dir) {
  const items = filtered();
  const idx = items.findIndex((n) => n.id === state.note?.id);
  const target = items[idx + dir];
  if (target) { state.sel = idx + dir; openNote(target); }
}

function settingsAction(action) {
  switch (action) {
    case 'down': state.settingsSel = Math.min(1, state.settingsSel + 1); break;
    case 'up': state.settingsSel = Math.max(0, state.settingsSel - 1); break;
    case 'open': case 'next': cycleSetting(1); break;
    case 'prev': cycleSetting(-1); break;
  }
}

function cycleSetting(dir) {
  if (state.settingsSel === 0) {
    const i = KEYMAPS.indexOf(state.config.keymap);
    state.config.keymap = KEYMAPS[(i + dir + KEYMAPS.length) % KEYMAPS.length];
    state.bindings = effectiveBindings(state.config);
  } else {
    const i = SORTS.indexOf(state.config.sort);
    state.config.sort = SORTS[(i + dir + SORTS.length) % SORTS.length];
    state.notes = sorted(state.notes, state.config.sort);
    state.sel = 0;
  }
  saveConfig(state.config);
}

function handleSearchKey(key) {
  if (key === 'enter') state.searching = false;
  else if (key === 'escape' || key === 'ctrl+g') { state.searching = false; state.query = ''; }
  else if (key === 'backspace') state.query = state.query.slice(0, -1);
  else if (key === 'space') state.query += ' ';
  else if (key === 'up' || key === 'down') { state.searching = false; return handleKey(key); }
  else if (!/^(ctrl|meta)\+/.test(key) && [...key].length === 1) state.query += key;
  state.sel = Math.max(0, Math.min(state.sel, filtered().length - 1));
  render();
}

// Number keys jump straight to a note on the current page. Multi-digit input
// commits as soon as no further digit could still name a visible note,
// otherwise after a short pause.
function handleDigit(digit) {
  if (!state.digits && digit === '0') return;
  const next = state.digits + digit;
  const count = currentPageItems().length;
  if (parseInt(next, 10) > count) { state.digits = ''; return render(); }
  state.digits = next;
  clearTimeout(state.digitTimer);
  if (parseInt(next, 10) * 10 > count) commitDigits();
  else { state.digitTimer = setTimeout(commitDigits, 500); render(); }
}

function commitDigits() {
  clearTimeout(state.digitTimer);
  const n = parseInt(state.digits, 10);
  state.digits = '';
  if (!n) return render();
  const item = currentPageItems()[n - 1];
  if (item) { state.sel = pageStart() + n - 1; openNote(item); }
  else render();
}

function listPageSize() {
  return Math.max(3, (process.stdout.rows || 24) - 6);
}

function pageStart() {
  return Math.floor(state.sel / listPageSize()) * listPageSize();
}

function currentPageItems() {
  return filtered().slice(pageStart(), pageStart() + listPageSize());
}

// --------------------------------------------------------------- rendering

function layout() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const W = Math.max(44, Math.min(cols - 2, 100));
  return { cols, rows, W, inner: W - 4, bodyRows: Math.max(3, rows - 7) };
}

function render() {
  const l = layout();
  let lines;
  if (state.view === 'note') lines = renderNote(l);
  else if (state.view === 'help') lines = renderHelp(l);
  else if (state.view === 'settings') lines = renderSettings(l);
  else if (state.view === 'error') lines = renderError(l);
  else lines = renderList(l);

  if (lines.length > l.rows - 1) lines = lines.slice(0, l.rows - 1);
  process.stdout.write(t.home + lines.map((x) => x + t.clearLine).join('\r\n') + '\r\n' + t.clearBelow);
}

function header(title, right, W) {
  const leftPlain = ' ✳ ' + title;
  const pad = Math.max(1, W - t.strWidth(leftPlain) - t.strWidth(right));
  return ' ' + t.accent('✳ ') + t.bold(title) + ' '.repeat(pad) + t.dim(right);
}

function boxTop(W) { return ' ' + t.dim('╭' + '─'.repeat(W - 2) + '╮'); }
function boxBottom(W) { return ' ' + t.dim('╰' + '─'.repeat(W - 2) + '╯'); }
function boxRow(content, inner) { return ' ' + t.dim('│') + ' ' + content + ' ' + t.dim('│'); }

function renderList(l) {
  const { W, inner } = l;
  const items = filtered();
  const page = currentPageItems();
  const pageSize = listPageSize();
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const pageNo = Math.floor(pageStart() / pageSize) + 1;

  let info;
  if (state.loading) info = `${SPINNER[state.spinner % SPINNER.length]} loading`;
  else if (state.query) info = `${items.length}/${state.notes.length} · “${t.truncate(state.query, 18)}”`;
  else info = `${state.notes.length} notes · by ${state.config.sort}`;
  if (pages > 1) info += ` · page ${pageNo}/${pages}`;

  const lines = ['', header('Apple Notes', info, W), boxTop(W)];

  if (state.loading && !items.length) {
    lines.push(boxRow(t.padRowPlain(` ${SPINNER[state.spinner % SPINNER.length]} Loading your notes…`, inner, t.dim), inner));
  } else if (!items.length) {
    const msg = state.query ? `No matches for “${state.query}”` : 'No notes found';
    lines.push(boxRow(t.padRowPlain(msg, inner, t.dim), inner));
  }

  page.forEach((item, i) => {
    const isSel = pageStart() + i === state.sel;
    const num = String(i + 1).padStart(2, ' ');
    const marker = isSel ? '❯' : ' ';
    const metaPlain = `${item.folder} · ${fmtDate(item.modified)}`;
    const meta = t.truncate(metaPlain, Math.max(10, Math.floor(inner * 0.4)));
    const titleW = inner - 2 - 1 - 1 - 1 - t.strWidth(meta) - 1;
    const title = t.truncate((item.locked ? '🔒 ' : '') + item.title, Math.max(5, titleW));
    const pad = Math.max(1, inner - 2 - 1 - 1 - 1 - t.strWidth(title) - t.strWidth(meta));
    const row =
      t.dim(num) + ' ' +
      (isSel ? t.accent(marker) : ' ') + ' ' +
      (isSel ? t.bold(title) : title) +
      ' '.repeat(pad) + t.dim(meta);
    lines.push(boxRow(row, inner));
  });

  lines.push(boxBottom(W));
  lines.push(listFooter(inner));
  return lines;
}

function listFooter(inner) {
  if (state.searching) return '  ' + t.accent('/ ') + state.query + t.accent('█');
  let hints = '↵ open · 1-9 jump · / search · r refresh · s settings · ? help · q quit';
  if (state.digits) return '  ' + t.accent(`→ ${state.digits}`) + '  ' + t.dim(t.truncate(hints, inner - 8));
  return '  ' + t.dim(t.truncate(hints, inner + 2));
}

function noteLines() {
  if (state.noteText === null) return [];
  const { inner } = layout();
  let text = state.noteText;
  const first = text.split('\n', 1)[0];
  if (state.note && first?.trim() === state.note.title.trim()) {
    text = text.slice(first.length).replace(/^\n+/, '');
  }
  return t.wrap(text, inner);
}

function renderNote(l) {
  const { W, inner, bodyRows } = l;
  const note = state.note;
  const meta = `${note.folder} · edited ${fmtDate(note.modified)}` +
    (note.created ? ` · created ${fmtDate(note.created)}` : '');

  const lines = [
    '',
    ' ' + t.accent('✳ ') + t.bold(t.truncate((note.locked ? '🔒 ' : '') + note.title, W - 4)),
    ' ' + t.dim(t.truncate(meta, W - 2)),
    boxTop(W),
  ];

  const body = noteLines();
  if (state.noteText === null) {
    lines.push(boxRow(t.padRowPlain(` ${SPINNER[state.spinner % SPINNER.length]} Loading…`, inner, t.dim), inner));
  } else if (!body.length || (body.length === 1 && !body[0])) {
    lines.push(boxRow(t.padRowPlain('(empty note)', inner, t.dim), inner));
  } else {
    const maxScroll = Math.max(0, body.length - bodyRows);
    state.noteScroll = Math.min(state.noteScroll, maxScroll);
    for (const line of body.slice(state.noteScroll, state.noteScroll + bodyRows)) {
      lines.push(boxRow(t.padRowPlain(line, inner, null), inner));
    }
  }

  lines.push(boxBottom(W));
  const pct = body.length
    ? Math.min(100, Math.round(((state.noteScroll + bodyRows) / Math.max(body.length, bodyRows)) * 100))
    : 100;
  lines.push('  ' + t.dim(t.truncate(`${pct}% · ↑↓ scroll · space page · ←→ prev/next · o Notes.app · esc back · q quit`, inner + 2)));
  return lines;
}

function renderHelp(l) {
  const { W } = l;
  const rows = [
    ['1-9', 'Open note by number'],
    ['down', 'Move down'],
    ['up', 'Move up'],
    ['pageDown', 'Page down'],
    ['pageUp', 'Page up'],
    ['top', 'Go to top'],
    ['bottom', 'Go to bottom'],
    ['open', 'Open note'],
    ['prev', 'Previous note (in note view)'],
    ['next', 'Next note (in note view)'],
    ['search', 'Search titles'],
    ['back', 'Back / clear search'],
    ['openExternal', 'Open in Notes.app (unlock locked notes there)'],
    ['refresh', 'Refresh notes / reload note'],
    ['settings', 'Settings'],
    ['help', 'Toggle this help'],
    ['quit', 'Quit'],
  ];

  const lines = ['', header('Keyboard', `keymap: ${state.config.keymap}`, W), ''];
  for (const [action, desc] of rows) {
    const keys = action === '1-9'
      ? '1-9'
      : (state.bindings[action] || []).map(prettyKey).join('  ');
    lines.push('   ' + t.accent(t.padEnd(t.truncate(keys, 30), 30)) + ' ' + desc);
  }
  lines.push('');
  lines.push('   ' + t.dim(`Add your own keys in ${configPath}`));
  lines.push('');
  lines.push('  ' + t.dim('esc back'));
  return lines;
}

function renderSettings(l) {
  const { W } = l;
  const rows = [
    ['Keymap', state.config.keymap, KEYMAPS],
    ['Sort', state.config.sort, SORTS],
  ];
  const lines = ['', header('Settings', '', W), ''];
  rows.forEach(([label, value, options], i) => {
    const isSel = state.settingsSel === i;
    const marker = isSel ? t.accent('❯') : ' ';
    const val = isSel ? t.accent(`‹ ${value} ›`) : value;
    lines.push(`   ${marker} ${t.padEnd(label, 8)} ${val}   ${t.dim('(' + options.join(' / ') + ')')}`);
  });
  lines.push('');
  lines.push('   ' + t.dim(`Saved to ${configPath}`));
  lines.push('');
  lines.push('  ' + t.dim('↑↓ select · ↵/←→ change · esc back'));
  return lines;
}

function renderError(l) {
  const { W } = l;
  const lines = ['', header('Apple Notes', '', W), ''];
  for (const line of t.wrap(state.error || 'Something went wrong.', W - 6)) {
    lines.push('   ' + line);
  }
  lines.push('');
  lines.push('  ' + t.dim('r retry · q quit'));
  return lines;
}

// ------------------------------------------------------------------- dates

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
  }
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

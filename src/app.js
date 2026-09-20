// Main TUI: state, key handling, and rendering for all views.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as t from './term.js';
import { loadConfig, saveConfig, configPath } from './config.js';
import { parseInput, effectiveBindings, actionFor, prettyKey } from './keys.js';
import { fetchNoteList, fetchNoteText, openInNotes, openAttachment, saveNoteText, createNote } from './store.js';

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
  noteAtts: [],
  noteScroll: 0,
  toast: null,
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
  let notes;
  try {
    notes = sorted(await fetchNoteList(), config.sort);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const folderW = Math.min(20, Math.max(5, ...notes.map((n) => t.strWidth(n.folder))));
  for (const n of notes) {
    console.log(`${fmtDate(n.modified).padEnd(13)} ${t.padEnd(t.truncate(n.folder, folderW), folderW)}  ${n.locked ? '🔒 ' : ''}${n.title}`);
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
  process.on('SIGTERM', exit);
  process.on('SIGHUP', exit);

  process.stdout.write(t.altOn + t.mouseOn);
  render();
  loadList();
}

function restoreTerminal() {
  clearInterval(state.spinTimer);
  clearTimeout(state.digitTimer);
  process.stdout.write(t.mouseOff + t.altOff);
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
  const cached = state.bodyCache.get(item.id);
  state.noteText = cached?.text ?? null;
  state.noteAtts = cached?.attachments ?? [];
  if (cached) return render();

  startSpinner();
  try {
    const { text, plain, attachments } = await fetchNoteText(item.id);
    if (item.locked && !text.trim()) {
      // Locked notes read as empty until unlocked in Notes.app. Don't cache,
      // so reopening after an unlock picks up the real text.
      if (state.note?.id === item.id) state.noteText = LOCKED_TEXT;
    } else {
      state.bodyCache.set(item.id, { text, plain, attachments });
      if (state.note?.id === item.id) { state.noteText = text; state.noteAtts = attachments; }
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
  state.toast = null;
  if (typeof key !== 'string') return handleClick(key);
  if (key === 'wheelup' || key === 'wheeldown') return handleWheel(key);
  if (key === 'ctrl+c') return exit();
  if (state.searching) return handleSearchKey(key);
  if (state.view === 'list' && /^[0-9]$/.test(key)) return handleDigit(key);
  if (state.view === 'note' && /^[1-9]$/.test(key)) return openFileAt(+key - 1);

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
    case 'edit': {
      const target = state.view === 'note' ? state.note : state.view === 'list' ? filtered()[state.sel] : null;
      if (target) editNote(target);
      return;
    }
    case 'new':
      if (state.view === 'list' || state.view === 'note') newNote();
      return;
    default: handleViewAction(action); break;
  }
  render();
}

// Screen rows are 1-based: row 2 is the header (with the × close button at
// the right edge), rows 4+ are the list/settings rows (blank, header, box top).
function handleClick({ x, y }) {
  const { W } = layout();
  if (y === 2 && x >= W - 2 && x <= W + 2) return exit();
  if (state.view === 'list') {
    const page = currentPageItems();
    const idx = y - 4;
    if (idx >= 0 && idx < page.length) {
      state.sel = pageStart() + idx;
      openNote(page[idx]);
    }
  } else if (state.view === 'settings') {
    const idx = y - 4;
    if (idx === 0 || idx === 1) {
      if (state.settingsSel === idx) cycleSetting(1);
      else state.settingsSel = idx;
      render();
    }
  } else if (state.view === 'note') {
    const idx = attachmentAtClick(x, y);
    if (idx >= 0) openFileAt(idx);
  }
}

// Maps a click in the note body to an attachment index. Clicking anywhere on
// a line holding a [📎 …] marker counts as clicking the file; when a line has
// several markers, x picks the one left of the click. Body rows start at
// screen row 5 (blank, title, meta, box top).
function attachmentAtClick(x, y) {
  const { bodyRows } = layout();
  const body = noteLines();
  const lineIdx = y - 5 + state.noteScroll;
  if (y < 5 || y >= 5 + bodyRows || lineIdx < 0 || lineIdx >= body.length) return -1;
  const line = body[lineIdx];
  if (!line.includes('📎')) return -1;

  let before = 0;
  for (let i = 0; i < lineIdx; i++) before += (body[i].match(/📎/g) || []).length;
  const rel = x - 4; // box border + padding sit left of the text
  let col = 0, seen = 0, pick = 0;
  for (const ch of line) {
    if (ch === '📎' && (col <= rel || seen === 0)) pick = seen;
    if (ch === '📎') seen++;
    col += t.strWidth(ch);
  }
  return before + pick;
}

function handleWheel(key) {
  const action = key === 'wheelup' ? 'up' : 'down';
  const steps = state.view === 'note' ? 3 : 1;
  for (let i = 0; i < steps; i++) handleViewAction(action);
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
    case 'pageDown': case 'next': state.sel = clamp(state.sel + page); break;
    case 'pageUp': case 'prev': state.sel = clamp(state.sel - page); break;
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
    case 'openFile': openFileAt(0); break;
  }
}

// Exports the i-th attachment through Notes.app and opens it with the
// default macOS app for its file type.
async function openFileAt(i) {
  const att = state.noteAtts[i];
  if (!att || !state.note) return;
  state.toast = `Opening ${att.name}…`;
  render();
  try {
    await openAttachment(state.note.id, att);
    state.toast = null;
  } catch (err) {
    state.toast = `⚠ Could not open: ${(err.message || 'failed').split('\n')[0]}`;
  }
  render();
}

function stepNote(dir) {
  const items = filtered();
  const idx = items.findIndex((n) => n.id === state.note?.id);
  const target = items[idx + dir];
  if (target) { state.sel = idx + dir; openNote(target); }
}

// Hands the note text to $EDITOR in the real terminal (TUI suspended), then
// writes any changes back to Apple Notes. The overwrite flattens rich
// formatting and drops inline attachments — accepted trade-off for `e`.
async function editNote(item) {
  if (item.locked) { state.toast = '⚠ Locked note — unlock it in Notes.app first (o)'; return render(); }
  let text = state.bodyCache.get(item.id)?.plain;
  if (text === undefined) {
    startSpinner();
    try { text = (await fetchNoteText(item.id)).plain; }
    catch (err) { state.toast = `⚠ ${err.message.split('\n')[0]}`; return render(); }
    finally { stopSpinner(); }
  }

  const edited = await runEditor(text);
  if (edited === null) return render();
  if (edited === text) { state.toast = 'No changes'; return render(); }

  state.toast = 'Saving…';
  render();
  try {
    await saveNoteText(item.id, edited);
    state.bodyCache.set(item.id, { text: edited, plain: edited, attachments: [] });
    if (state.note?.id === item.id) {
      state.noteText = edited;
      state.noteAtts = [];
      state.note.title = (edited.split('\n', 1)[0] || 'Untitled').trim() || 'Untitled';
    }
    state.toast = '✓ Saved to Apple Notes';
    loadList(); // pick up new title/modified date in the list
  } catch (err) {
    state.toast = `⚠ Save failed: ${err.message.split('\n')[0]}`;
  }
  render();
}

// Suspends the TUI and runs $EDITOR on a temp file seeded with `initial`.
// Returns the buffer contents, or null (with a toast set) on editor failure.
async function runEditor(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-edit-'));
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, initial, { mode: 0o600 });
  const [cmd, ...args] = (process.env.VISUAL || process.env.EDITOR || 'vim').split(' ');
  suspendTui();
  const code = await new Promise((resolve) => {
    const child = spawn(cmd, [...args, file], { stdio: 'inherit' });
    child.on('exit', resolve);
    child.on('error', () => resolve(-1));
  });
  resumeTui();

  let edited = null;
  try { edited = fs.readFileSync(file, 'utf8'); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  if (code !== 0 || edited === null) {
    state.toast = `⚠ ${cmd} ${code === -1 ? 'could not be started' : `exited with ${code}`} — nothing saved`;
    return null;
  }
  return edited;
}

// Drafts a new note in $EDITOR; saving a non-empty buffer creates it in the
// default folder and selects it in the list.
async function newNote() {
  const edited = await runEditor('');
  if (edited === null) return render();
  if (!edited.trim()) { state.toast = 'Empty buffer — no note created'; return render(); }

  state.toast = 'Creating…';
  render();
  try {
    const id = await createNote(edited);
    state.view = 'list';
    state.note = null;
    await loadList();
    const idx = filtered().findIndex((note) => note.id === id);
    if (idx >= 0) state.sel = idx;
    state.toast = '✓ Note created';
  } catch (err) {
    state.toast = `⚠ Create failed: ${err.message.split('\n')[0]}`;
  }
  render();
}

function suspendTui() {
  stopSpinner();
  process.stdout.write(t.mouseOff + t.altOff);
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

function resumeTui() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(t.altOn + t.mouseOn);
  render();
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
  const rightPlain = right ? right + '  ×' : '×';
  const leftPlain = ' ✳ ' + title;
  const pad = Math.max(1, W - t.strWidth(leftPlain) - t.strWidth(rightPlain));
  return ' ' + t.accent('✳ ') + t.bold(title) + ' '.repeat(pad) + t.dim(rightPlain);
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
  if (state.toast) return '  ' + t.accent(t.truncate(state.toast, inner + 2));
  let hints = '↵ open · 1-9 jump · ←→ page · / search · n new · e edit · r refresh · s settings · ? help · q quit';
  if (state.digits) return '  ' + t.accent(`→ ${state.digits}`) + '  ' + t.dim(t.truncate(hints, inner - 8));
  return '  ' + t.dim(t.truncate(hints, inner + 2));
}

function noteLines() {
  if (state.noteText === null) return [];
  const { inner } = layout();
  let text = state.noteText;
  const first = text.split('\n', 1)[0];
  if (state.note && isTitleLine(first, state.note.title)) {
    text = text.slice(first.length).replace(/^\n+/, '');
  }
  return t.wrap(text, inner);
}

// Notes.app truncates long `name`s with an ellipsis, so also treat the line
// as the title when it starts with the title minus its trailing ….
export function isTitleLine(line, title) {
  const l = (line || '').trim();
  const tt = (title || '').trim();
  if (!l || !tt) return false;
  if (l === tt) return true;
  const m = tt.match(/^(.*?)(…|\.\.\.)$/);
  return !!m && m[1].length > 0 && l.startsWith(m[1].trimEnd());
}

function renderNote(l) {
  const { W, inner, bodyRows } = l;
  const note = state.note;
  const meta = `${note.folder} · edited ${fmtDate(note.modified)}` +
    (note.created ? ` · created ${fmtDate(note.created)}` : '');

  const title = t.truncate((note.locked ? '🔒 ' : '') + note.title, W - 8);
  const titlePad = Math.max(1, W - t.strWidth(' ✳ ' + title) - 1);
  const lines = [
    '',
    ' ' + t.accent('✳ ') + t.bold(title) + ' '.repeat(titlePad) + t.dim('×'),
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
  const fileHint = state.noteAtts.length ? 'a/1-9/click open file · ' : '';
  const footer = `${pct}% · ${fileHint}↑↓ scroll · space page · ←→ prev/next · e edit · o Notes.app · esc back · q quit`;
  lines.push('  ' + (state.toast
    ? t.accent(t.truncate(state.toast, inner + 2))
    : t.dim(t.truncate(footer, inner + 2))));
  return lines;
}

function renderHelp(l) {
  const { W, cols, rows } = l;
  const entries = [
    ['1-9', 'Open note / attachment by number'],
    ['down', 'Move down'],
    ['up', 'Move up'],
    ['pageDown', 'Page down'],
    ['pageUp', 'Page up'],
    ['top', 'Go to top'],
    ['bottom', 'Go to bottom'],
    ['open', 'Open note'],
    ['prev', 'Page back (list) / previous note (note view)'],
    ['next', 'Page forward (list) / next note (note view)'],
    ['search', 'Search titles'],
    ['back', 'Back / clear search'],
    ['openExternal', 'Open in Notes.app (unlock locked notes there)'],
    ['openFile', 'Open attachment in its default app (note view)'],
    ['edit', 'Edit in $EDITOR, saved back to Apple Notes'],
    ['new', 'New note drafted in $EDITOR'],
    ['refresh', 'Refresh notes / reload note'],
    ['settings', 'Settings'],
    ['help', 'Toggle this help'],
    ['quit', 'Quit'],
  ].map(([action, desc]) => {
    const keys = action === '1-9'
      ? '1-9'
      : (state.bindings[action] || []).map(prettyKey).join('  ');
    return [keys, desc];
  });
  entries.push(['click', 'Open note / attachment / setting'], ['click ×', 'Quit'], ['wheel', 'Scroll']);

  const lines = ['', header('Keyboard', `keymap: ${state.config.keymap}`, W), ''];
  const tail = ['', '   ' + t.dim(`Add your own keys in ${configPath}`), '', '  ' + t.dim('esc back')];

  // Wrap into extra columns when the rows won't fit the terminal height.
  const avail = Math.max(3, rows - 1 - lines.length - tail.length);
  const maxKeyW = Math.min(30, Math.max(...entries.map(([keys]) => t.strWidth(keys))));
  const nCols = Math.max(1, Math.min(
    Math.ceil(entries.length / avail),
    Math.floor((cols - 3) / 34), // each column needs room for keys + a short description
  ));
  const colH = Math.ceil(entries.length / nCols);
  const cellW = Math.floor((cols - 3) / nCols) - 2;
  const keyW = nCols === 1 ? maxKeyW : Math.min(maxKeyW, Math.max(12, cellW - 20));

  for (let r = 0; r < colH; r++) {
    let line = '   ';
    for (let c = 0; c < nCols; c++) {
      const entry = entries[c * colH + r];
      if (!entry) break;
      const [keys, desc] = entry;
      const d = t.truncate(desc, Math.max(6, (nCols === 1 ? cols - 4 : cellW) - keyW - 1));
      line += t.accent(t.padEnd(t.truncate(keys, keyW), keyW)) + ' ' + d;
      if (c < nCols - 1) line += ' '.repeat(Math.max(2, cellW - keyW - 1 - t.strWidth(d) + 2));
    }
    lines.push(line);
  }
  lines.push(...tail);
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

// Data layer: talks to Notes.app over Apple Events via osascript (JXA).
// Kept behind this interface so a faster backend (e.g. direct SQLite reads)
// could be swapped in later without touching the UI.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function runJXA(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim();
          if (/-1743|not authori[sz]ed/i.test(msg)) {
            reject(new Error(
              'macOS blocked access to Notes.\n' +
              'Open System Settings → Privacy & Security → Automation and\n' +
              'allow your terminal app to control Notes, then try again.'
            ));
          } else {
            reject(new Error(msg || 'osascript failed'));
          }
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

const LIST_SCRIPT = `
(() => {
  const app = Application('Notes');
  const out = [];
  for (const folder of app.folders()) {
    const folderName = folder.name();
    if (folderName === 'Recently Deleted') continue;
    let ids, titles, modified, created;
    try {
      const notes = folder.notes;
      ids = notes.id();
      titles = notes.name();
      modified = notes.modificationDate();
      created = notes.creationDate();
    } catch (e) {
      continue;
    }
    let locked = null;
    try { locked = folder.notes.passwordProtected(); } catch (e) {}
    for (let i = 0; i < ids.length; i++) {
      out.push({
        id: ids[i],
        title: titles[i] || 'Untitled',
        folder: folderName,
        modified: modified[i] ? modified[i].toISOString() : null,
        created: created[i] ? created[i].toISOString() : null,
        locked: locked ? !!locked[i] : false,
      });
    }
  }
  return JSON.stringify(out);
})()`;

export async function fetchNoteList() {
  const raw = await runJXA(LIST_SCRIPT);
  const notes = JSON.parse(raw);
  const seen = new Set();
  return notes.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    n.title = sanitize(n.title) || 'Untitled';
    n.folder = sanitize(n.folder);
    return true;
  });
}

export async function fetchNoteText(id) {
  const script = `
(() => {
  const app = Application('Notes');
  const note = app.notes.byId(${JSON.stringify(id)});
  let ids = [], names = [];
  try {
    ids = note.attachments.id();
    names = note.attachments.name();
  } catch (e) {}
  return JSON.stringify({ text: note.plaintext(), ids, names });
})()`;
  const { text, ids, names } = JSON.parse(await runJXA(script));
  const attachments = ids.map((attId, i) => ({ id: attId, name: sanitize(names[i]) || 'attachment' }));
  const plain = sanitize(text);
  // U+FFFC marks inline attachments (images, tables) that plaintext can't
  // carry. They appear in the same order as the note's attachment list, so
  // substitute each marker with the matching filename.
  let i = 0;
  const rendered = plain.replace(/￼/g, () => {
    const name = attachments[i++]?.name;
    return name ? `[📎 ${name}]` : '[attachment]';
  });
  return { text: rendered, plain: plain.replace(/￼/g, ''), attachments };
}

// Strips terminal control characters (C0/C1, DEL) so note content can't
// inject escape sequences into the TUI. Keeps tab and newline.
export function sanitize(s) {
  return (s || '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

// Exports an attachment through Notes.app (which can read its own container —
// this process can't without Full Disk Access) and opens it with the default
// app. Exports land in one temp dir per run and are reused on reopen.
let exportDir = null;

export async function openAttachment(noteId, attachment) {
  if (!exportDir) exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-cli-'));
  const safe = (attachment.name || 'attachment').replace(/[/:]/g, '_');
  const dest = path.join(exportDir, safe);
  if (!fs.existsSync(dest)) {
    const script = `
(() => {
  const app = Application('Notes');
  const att = app.notes.byId(${JSON.stringify(noteId)}).attachments.byId(${JSON.stringify(attachment.id)});
  app.save(att, { in: Path(${JSON.stringify(dest)}) });
})()`;
    await runJXA(script);
    await dequarantine(dest);
  }
  await new Promise((resolve, reject) => {
    execFile('open', [dest], (err) => (err ? reject(err) : resolve()));
  });
}

// Notes' `save` stamps exports with com.apple.quarantine (agent "Notes"),
// which makes Preview & co. refuse the file as "damaged". Clear it for
// documents, but leave Gatekeeper's check in place for anything runnable.
const RUNNABLE = /\.(app|pkg|dmg|command|tool|sh|zsh|bash|scpt|scptd|applescript|workflow|action|terminal|jar|py|rb|pl|js)$/i;

function dequarantine(file) {
  if (RUNNABLE.test(file)) return Promise.resolve();
  try {
    if (fs.statSync(file).isDirectory() || fs.statSync(file).mode & 0o111) return Promise.resolve();
  } catch { return Promise.resolve(); }
  return new Promise((resolve) => {
    execFile('xattr', ['-d', 'com.apple.quarantine', file], () => resolve());
  });
}

// Notes bodies are HTML: each line becomes a <div>, and Notes derives the
// note title from the first line.
function textToHtml(text) {
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split('\n')
    .map((line) => (line.trim() ? `<div>${esc(line)}</div>` : '<div><br></div>'))
    .join('');
}

// Replaces the note's body with plain text. Rich formatting and inline
// attachments in the old body are lost, which the user accepted for
// in-terminal editing.
export async function saveNoteText(id, text) {
  const html = textToHtml(text);
  const script = `
(() => {
  const app = Application('Notes');
  app.notes.byId(${JSON.stringify(id)}).body = ${JSON.stringify(html)};
})()`;
  await runJXA(script);
}

// Creates a note in the default account's default folder; returns its id.
export async function createNote(text) {
  const script = `
(() => {
  const app = Application('Notes');
  const note = app.Note({ body: ${JSON.stringify(textToHtml(text))} });
  app.defaultAccount.notes.push(note);
  return note.id();
})()`;
  return runJXA(script);
}

// Brings the note up in Notes.app itself. For password-protected notes this
// is the unlock path: Notes prompts for Touch ID / password, and once the
// session is unlocked its text becomes readable over Apple Events too.
export async function openInNotes(id) {
  const script = `
(() => {
  const app = Application('Notes');
  app.activate();
  app.notes.byId(${JSON.stringify(id)}).show();
})()`;
  await runJXA(script);
}

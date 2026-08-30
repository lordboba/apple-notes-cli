// Data layer: talks to Notes.app over Apple Events via osascript (JXA).
// Kept behind this interface so a faster backend (e.g. direct SQLite reads)
// could be swapped in later without touching the UI.
import { execFile } from 'node:child_process';

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
    return true;
  });
}

export async function fetchNoteText(id) {
  const script = `
(() => {
  const app = Application('Notes');
  const note = app.notes.byId(${JSON.stringify(id)});
  let attachments = [];
  try { attachments = note.attachments.name(); } catch (e) {}
  return JSON.stringify({ text: note.plaintext(), attachments });
})()`;
  const { text, attachments } = JSON.parse(await runJXA(script));
  // U+FFFC marks inline attachments (images, tables) that plaintext can't
  // carry. They appear in the same order as the note's attachment list, so
  // substitute each marker with the matching filename.
  let i = 0;
  return (text || '').replace(/￼/g, () => {
    const name = attachments[i++];
    return name ? `[📎 ${name}]` : '[attachment]';
  });
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

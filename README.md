# notes — a terminal UI for Apple Notes

A fast, clean TUI for browsing your Apple Notes from the terminal. Zero dependencies — plain Node.js talking to Notes.app over Apple Events (JXA).

```
 ✳ Apple Notes                              83 notes · by modified · page 1/5
 ╭────────────────────────────────────────────────────────────────────────────╮
 │  1 ❯ Draft up notion doc                                    Notes · Aug 28 │
 │  2   Bank account                                           Notes · Aug 18 │
 │  3   Parallelization                                        Notes · Jul 27 │
 ╰────────────────────────────────────────────────────────────────────────────╯
   ↵ open · 1-9 jump · / search · r refresh · s settings · ? help · q quit
```

## Install

```sh
npm install -g apple-notes-tui
notes
```

Or from source:

```sh
git clone https://github.com/lordboba/apple-notes-cli.git
cd apple-notes-cli
npm install -g .     # or: npm link
notes
```

Requires macOS and Node 18+. On first run, macOS may ask you to allow your
terminal to control Notes (System Settings → Privacy & Security → Automation).

## Usage

```sh
notes           # interactive UI
notes list      # plain-text dump of all notes (pipe-friendly)
notes --help
```

## Keys

Arrow keys, PgUp/PgDn, Home/End, and Enter always work. On top of that,
both vim and emacs bindings are active by default (the `hybrid` keymap):

| Action           | Common       | vim                | emacs          |
| ---------------- | ------------ | ------------------ | -------------- |
| Move down / up   | ↓ / ↑        | `j` / `k`          | `C-n` / `C-p`  |
| Page down / up   | PgDn / space | `C-d` / `C-u`      | `C-v` / `M-v`  |
| Top / bottom     | Home / End   | `gg` / `G`         | `M-<` / `M->`  |
| Open note        | ↵            |                    |                |
| Jump to note     | `1`–`9` (multi-digit works too) |  |                |
| Prev / next note | ← / →        | `h` / `l`          |                |
| Back             | esc          |                    | `C-g`          |
| Search titles    | `/`          |                    |                |
| Open in Notes.app| `o`          |                    |                |
| Open attachment  | `a` (or `1`–`9`) |                |                |
| Edit note        | `e`          |                    |                |
| New note         | `n`          |                    |                |
| Refresh / reload | `r`          |                    |                |
| Settings         | `s`          |                    |                |
| Help             | `?`          |                    |                |
| Quit             | `q`, `C-c`   |                    |                |

In the note view, ←/→ (or `h`/`l`) move between notes without going back to
the list. In the list, ←/→ flip whole pages.

The mouse works too: click a note to open it, click a settings row to change
it, scroll with the wheel, and click the `×` in the top-right corner to quit.
(Terminals reserve text selection while mouse mode is on — hold Shift or Fn
to select text as usual.)

Inline attachments show as `[📎 filename]` — click one (or press `a` for the
first, `1`–`9` for the nth) to open it with its default macOS app. Under the
hood, Notes.app exports the file to a temp directory first, since attachment
files aren't directly readable without Full Disk Access.

Locked notes are marked with 🔒;
macOS only lets Notes.app itself take the password or Touch ID prompt, so
press `o` to unlock a note there, then `r` back in the TUI to reload its
text.

## Configuration

Settings live at `~/.config/notes-cli/config.json` and can be changed in-app
by pressing `s`:

```json
{
  "keymap": "hybrid",
  "sort": "modified",
  "keys": {
    "quit": ["x"],
    "pageDown": ["ctrl+j"]
  }
}
```

- `keymap` — `hybrid` (default), `vim`, or `emacs`
- `sort` — `modified` (default), `created`, or `title`
- `keys` — extra bindings per action, added on top of the keymap. Key names:
  single characters (`x`, `G`), `ctrl+<letter>`, `meta+<char>`, `up`, `down`,
  `left`, `right`, `pageup`, `pagedown`, `home`, `end`, `enter`, `escape`,
  `space`, or two-key chords like `"g g"`.

## How it works

- `src/store.js` fetches notes via `osascript -l JavaScript` (Apple Events),
  the only official API for Notes. Titles/dates load in bulk; note bodies are
  fetched lazily on open and cached for the session.
- `src/app.js` is the TUI: state, key handling, and rendering.
- `src/keys.js` parses raw stdin and resolves keymaps/chords.
- `src/term.js` handles ANSI styling and emoji/CJK-aware text layout.

Browsing never modifies your notes. Writes happen only through `e` (edit) and
`n` (new): the note's plain text opens in `$VISUAL`/`$EDITOR`, and saving
writes it back to Apple Notes — `n` starts from an empty buffer and creates
the note in your default folder (first line becomes the title; quit without
writing anything and no note is created). **Edits replace the whole note
body** — rich formatting
(bold, checklists, tables) is flattened to plain text and inline attachments
are dropped from the edited note. "Recently Deleted" and password-locked note
contents are not shown.

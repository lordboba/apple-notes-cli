// User config lives at ~/.config/notes-cli/config.json (or $XDG_CONFIG_HOME).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
export const configPath = path.join(configDir, 'notes-cli', 'config.json');

export const DEFAULTS = {
  keymap: 'hybrid', // hybrid | vim | emacs
  sort: 'modified', // modified | created | title
  keys: {}, // extra bindings per action, e.g. { "quit": ["x"] }
};

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { ...DEFAULTS, ...raw, keys: raw.keys || {} };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

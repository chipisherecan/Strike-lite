// Server and tools: finds maps imported from the user's own CS2 install. They live outside the project and are never published.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerRealMap } from './maps.js';

export function realMapsDir() {
  // the home folder, not AppData: packaged Windows apps get a private copy of AppData that other programs can't see
  return process.env.STRIKE_MAPS || path.join(os.homedir(), 'StrikeLiteMaps');
}

export function realMapList() {
  const dir = realMapsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => fs.existsSync(path.join(dir, n, 'meta.json')));
}

export function loadRealMaps() {
  const list = realMapList();
  for (const id of list) {
    const dir = path.join(realMapsDir(), id), meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const b = fs.readFileSync(path.join(dir, 'collision.bin'));
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    registerRealMap(id, meta, ab);
  }
  return list;
}

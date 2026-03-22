import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

export function loadJsonConfig() {
  const userPath = path.join(root, 'config.json');
  const examplePath = path.join(root, 'config.example.json');
  const file = fs.existsSync(userPath) ? userPath : examplePath;
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

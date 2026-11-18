// Idempotent repair for the Loon VLESS credential line in src/engine.mjs.
// Official shape: protocol, server, port, "<uuid>", then named fields.
// https://nsloon.bid/document/node
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const IDENT = '[\\p{L}_$][\\p{L}\\p{N}_$]*';
const BROKEN = new RegExp('`udp=true`, `username=\\$\\{(' + IDENT + ')\\.uuid\\}`, `transport=ws`', 'u');
const MISPLACED = new RegExp('`udp=true`, `"\\$\\{(' + IDENT + ')\\.uuid\\}"`, `transport=ws`', 'u');
const FIXED = new RegExp('`"\\$\\{(' + IDENT + ')\\.uuid\\}"`, `udp=true`, `transport=ws`', 'u');

export class RepairError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RepairError';
    this.exitCode = 2;
  }
}

function hits(pattern, line) {
  const found = [];
  let from = 0;
  while (from <= line.length) {
    const slice = line.slice(from);
    const match = pattern.exec(slice);
    if (!match) break;
    found.push({ index: from + match.index, text: match[0], ident: match[1] });
    from += match.index + match[0].length;
  }
  return found;
}

function canonical(ident) {
  return '`"${' + ident + '.uuid}"`, `udp=true`, `transport=ws`';
}

export function repairLoonVlessSource(source) {
  if (typeof source !== 'string') throw new RepairError('Loon repair expected source text');
  const newline = source.endsWith('\n');
  const lines = source.split('\n');
  const passwordBefore = lines.filter(line => line.includes('password='));
  let sites = 0;
  let changed = 0;
  const next = lines.map(line => {
    const broken = hits(BROKEN, line);
    const misplaced = hits(MISPLACED, line);
    const fixed = hits(FIXED, line);
    const recognized = broken.length + misplaced.length + fixed.length;
    if (line.includes('username=') && broken.length !== 1) {
      throw new RepairError('username= is not the known Loon VLESS credential field; refusing to guess');
    }
    if (line.includes('password=') && recognized) {
      throw new RepairError('Loon VLESS credential pattern matched a password field; refusing to edit it');
    }
    if (!recognized) return line;
    if (!line.includes('path=') || !line.includes('over-tls=')) {
      throw new RepairError('Loon VLESS credential line is missing path or over-tls; refusing to edit it');
    }
    if (recognized !== 1) throw new RepairError('Loon VLESS credential line is ambiguous; refusing to edit it');
    sites += 1;
    if (fixed.length === 1) return line;
    const ident = (broken[0] || misplaced[0]).ident;
    changed += 1;
    return line.replace((broken[0] || misplaced[0]).text, canonical(ident));
  });
  if (sites !== 1) {
    throw new RepairError(sites === 0
      ? 'Loon VLESS serializer not found; refusing to guess'
      : 'Loon VLESS serializer matched ' + sites + ' times; refusing to guess');
  }
  const joined = next.join('\n');
  if (joined.includes('username=')) throw new RepairError('username= remains after the Loon VLESS repair');
  const fixedLines = joined.split('\n').filter(line => hits(FIXED, line).length);
  if (fixedLines.length !== 1 || hits(FIXED, fixedLines[0]).length !== 1) {
    throw new RepairError('Loon VLESS repair did not leave exactly one positional UUID');
  }
  const passwordAfter = joined.split('\n').filter(line => line.includes('password='));
  if (passwordBefore.join('\n') !== passwordAfter.join('\n')) {
    throw new RepairError('Loon VLESS repair changed a password field');
  }
  return { source: joined, status: changed ? 'repaired' : 'unchanged' };
}

export async function repairLoonVlessFile(file, { check = false } = {}) {
  const target = resolve(file);
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new RepairError('refusing to repair a symlink: ' + target);
  if (!info.isFile()) throw new RepairError('refusing to repair a non-file: ' + target);
  if (info.size > 2_000_000) throw new RepairError('refusing to repair an unexpectedly large file');
  const original = await readFile(target, 'utf8');
  const result = repairLoonVlessSource(original);
  if (!check && result.status === 'repaired') {
    const temporary = target + '.repair-' + randomBytes(6).toString('hex');
    await writeFile(temporary, result.source);
    await rename(temporary, target);
  }
  return result.status;
}

async function main() {
  const check = process.argv.includes('--check');
  const fileFlag = process.argv.indexOf('--file');
  const file = fileFlag >= 0 ? process.argv[fileFlag + 1] : resolve(dirname(fileURLToPath(import.meta.url)), '../src/engine.mjs');
  if (!file) throw new RepairError('missing --file path');
  const status = await repairLoonVlessFile(file, { check });
  process.stdout.write(status + '\n');
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  main().catch(error => {
    process.stderr.write((error && error.message ? error.message : String(error)) + '\n');
    process.exitCode = error && error.exitCode ? error.exitCode : 1;
  });
}

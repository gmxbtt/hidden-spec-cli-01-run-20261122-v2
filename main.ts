// mend — one patch tool for every AI edit format.
//
// An AI model writes an edit as a unified diff (often with wrong line numbers),
// a SEARCH/REPLACE block, a V4A patch, or text-editor tool calls as JSON. mend
// reads any of the four, finds the lines each edit names even when the model
// drifted their whitespace or indentation, and changes every file or none.
// SPEC.md (in the kit) is the whole contract; this file implements it,
// sections 1 to 10. Node 22, standard library alone. Run it as:
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A whole-run refusal: exit 2 with one line. */
class AbortRun {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** One edit's failure: exit 1, one `error: <code> <path>` line each. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start with `/`,
 *  holds no `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
const isSafePath = (p: string): boolean =>
  p !== '' && !p.startsWith('/') && !p.includes('\\') &&
  p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const trimTail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A file as lines plus its own line break and whether it ends with one (SPEC.md section 3).
 *  The break is CRLF when the first line feed follows a carriage return, LF otherwise.
 *  An empty file has no lines and no final break; a file of no lines is written empty. */
interface FileShape {
  rows: string[];
  br: '\r\n' | '\n';
  tail: boolean;
}

function readShape(text: string): FileShape {
  if (text === '') return { rows: [], br: '\n', tail: false };
  const firstNl = text.indexOf('\n');
  const br: '\r\n' | '\n' = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const rows = text.split(br);
  const tail = text.endsWith(br);
  if (tail) rows.pop();
  return { rows, br, tail };
}

function writeShape(shape: FileShape): string {
  if (shape.rows.length === 0) return '';
  return shape.rows.join(shape.br) + (shape.tail ? shape.br : '');
}

/** SPEC.md section 5: one line equal at a tier. Tier 0 is exact, tier 1 ignores trailing
 *  spaces and tabs on both sides, tier 2 ignores leading and trailing spaces and tabs. */
function lineEqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTail(a) === trimTail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every 0-based position where `want` occurs in `rows` at a tier; occurrences may overlap. */
function findSpots(rows: string[], want: string[], tier: number): number[] {
  const spots: number[] = [];
  if (want.length === 0) return spots;
  for (let i = 0; i + want.length <= rows.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (!lineEqAt(rows[i + j]!, want[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) spots.push(i);
  }
  return spots;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which `want` occurs at least once. */
function firstTierWith(rows: string[], want: string[], strict: boolean): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const spots = findSpots(rows, want, t);
    if (spots.length > 0) return { tier: t, spots };
  }
  return null;
}

/** The first tier with an occurrence at or after `from`. */
function firstTierFrom(rows: string[], want: string[], strict: boolean, from: number): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const spots = findSpots(rows, want, t).filter((s) => s >= from);
    if (spots.length > 0) return { tier: t, spots };
  }
  return null;
}

/** One line of a replacement: `ctx` names its index in the old lines when it is a context
 *  line (written as the file's own matched line, never the patch's), null when it is added. */
interface FreshLine {
  text: string;
  ctx: number | null;
}

/** Tier 2 re-indent of one added line: P, the leading spaces and tabs of the old lines'
 *  first line, is replaced by F, those of the file's first matched line. A line that is
 *  empty, only whitespace, or does not start with P is written as it is. */
function reindentLine(text: string, p: string, f: string): string {
  if (text === '' || text.trim() === '') return text;
  return text.startsWith(p) ? f + text.slice(p.length) : text;
}

/** Replace `oldLen` lines at `at` with `fresh`, honouring context lines and tier 2 re-indent. */
function swapLines(rows: string[], at: number, oldLen: number, fresh: FreshLine[], tier: number, oldFirst: string): string[] {
  const out = rows.slice(0, at);
  const f = at < rows.length ? leadWs(rows[at]!) : '';
  const p = leadWs(oldFirst);
  for (const part of fresh) {
    if (part.ctx !== null) out.push(rows[at + part.ctx]!);
    else if (tier === 2) out.push(reindentLine(part.text, p, f));
    else out.push(part.text);
  }
  out.push(...rows.slice(at + oldLen));
  return out;
}

/** The tree as the edits leave it: changed paths in `pending` (null: deleted), the rest
 *  read from disk. Moves are recorded so the output can print an `R` line for them. */
class WorkTree {
  private cache = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];

  disk(p: string): string | null {
    if (!this.cache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.cache.set(p, v);
    }
    return this.cache.get(p)!;
  }

  read(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.disk(p);
  }
}

type EditFn = (tree: WorkTree) => void;

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonOne(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: WorkTree): string => {
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    const t = tree.read(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.read(p) !== null) throw new EditFault('exists', p);
      tree.pending.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const body = norm(before);
      const want = norm(oldStr);
      let n = 0;
      for (let k = body.indexOf(want); k >= 0; k = body.indexOf(want, k + 1)) n += 1;
      if (n === 0) throw new EditFault('no-match', p);
      if (n > 1) throw new EditFault('ambiguous', p);
      const at = body.indexOf(want);
      const out = body.slice(0, at) + norm(newStr) + body.slice(at + want.length);
      tree.pending.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const atLine = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = need(tree);
      const shape = readShape(before);
      if (atLine < 0 || atLine > shape.rows.length) throw new EditFault('no-match', p);
      shape.rows.splice(atLine, 0, ...add);
      tree.pending.set(p, writeShape(shape));
    };
  }
  return null;
}

/** All JSON edits of a patch: one array, or JSON Lines with one edit object a line. */
function jsonAll(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new AbortRun('error: parse 1');
  const out: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new AbortRun(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new AbortRun(`error: parse ${first + 1}`);
    for (const item of v) {
      const e = jsonOne(item);
      if (e === null) throw new AbortRun(`error: parse ${first + 1}`);
      out.push(e);
    }
    return out;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonOne(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new AbortRun(`error: parse ${i + 1}`);
    out.push(e);
  });
  return out;
}

/** SPEC.md section 4: the first format whose test holds, or null. */
function sniff(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new.
 *  `noeol` is set when a `\` line follows it (no newline at end of file). */
interface BodyBit {
  kind: ' ' | '-' | '+';
  text: string;
  noeol: boolean;
}

interface Hunk {
  start: number;
  bits: BodyBit[];
}

interface DiffSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, spaces
 *  removed; `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function headerPath(rest: string): string | null {
  let s = rest;
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) return s.slice(2);
  return s;
}

const GIT_RE = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a unified diff into its sections (SPEC.md section 6). */
function parseUnified(lines: string[]): DiffSection[] {
  const sections: DiffSection[] = [];
  let cur: DiffSection | null = null;
  let i = 0;
  const freshSection = (): DiffSection => ({
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    gitOld: null,
    gitNew: null,
    create: false,
    remove: false,
    hunks: [],
  });
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const git = GIT_RE.exec(line);
      if (git === null) throw new AbortRun(`error: parse ${i + 1}`);
      cur = freshSection();
      cur.gitOld = git[1]!;
      cur.gitNew = git[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A new section, unless this pair is the current section's own header.
      if (cur === null || cur.hunks.length > 0 || cur.oldPath !== null || cur.newPath !== null) {
        cur = freshSection();
        sections.push(cur);
      }
      cur.oldPath = headerPath(line.slice(4));
      cur.newPath = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new AbortRun(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new AbortRun(`error: parse ${i + 1}`);
      const hunk: Hunk = { start: Number(m[1]), bits: [] };
      cur.hunks.push(hunk);
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          if (b[0] === '\\') {
            const prev = hunk.bits[hunk.bits.length - 1];
            if (prev !== undefined) prev.noeol = true;
          } else if (b === '') {
            hunk.bits.push({ kind: ' ', text: '', noeol: false });
          } else {
            hunk.bits.push({ kind: b[0] as ' ' | '-' | '+', text: b.slice(1), noeol: false });
          }
          i++;
        } else break;
      }
      while (hunk.bits.length > 0) {
        const last = hunk.bits[hunk.bits.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.bits.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new AbortRun(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.newPath = headerPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** The old and new lines of a hunk, with context lines marked by their index in the old lines. */
function hunkParts(hunk: Hunk): { oldLines: string[]; fresh: FreshLine[]; lastNoEol: boolean } {
  const oldLines: string[] = [];
  const fresh: FreshLine[] = [];
  let lastNoEol = false;
  for (const b of hunk.bits) {
    if (b.kind === ' ') {
      oldLines.push(b.text);
      fresh.push({ text: b.text, ctx: oldLines.length - 1 });
      lastNoEol = b.noeol;
    } else if (b.kind === '-') {
      oldLines.push(b.text);
      lastNoEol = false;
    } else {
      fresh.push({ text: b.text, ctx: null });
      lastNoEol = b.noeol;
    }
  }
  return { oldLines, fresh, lastNoEol };
}

const hunkOldLen = (h: Hunk): number => h.bits.filter((b) => b.kind === ' ' || b.kind === '-').length;
const hunkNewLen = (h: Hunk): number => h.bits.filter((b) => b.kind === ' ' || b.kind === '+').length;

/** Apply one hunk to a file's shape. `drift` is the sum of (new length minus old length)
 *  over this section's hunks applied so far. */
function applyHunk(shape: FileShape, hunk: Hunk, strict: boolean, path: string, drift: number): FileShape {
  const { oldLines, fresh, lastNoEol } = hunkParts(hunk);
  if (oldLines.length > 0) {
    const found = firstTierWith(shape.rows, oldLines, strict);
    if (found === null) throw new EditFault('no-match', path);
    const target = hunk.start - 1 + drift;
    let at = found.spots[0]!;
    let best = Math.abs(at - target);
    for (const s of found.spots) {
      const dist = Math.abs(s - target);
      if (dist < best) {
        best = dist;
        at = s;
      }
    }
    const touchesEnd = at + oldLines.length === shape.rows.length;
    const rows = swapLines(shape.rows, at, oldLines.length, fresh, found.tier, oldLines[0]!);
    return { rows, br: shape.br, tail: touchesEnd ? !lastNoEol : shape.tail };
  }
  const idx = Math.min(hunk.start + drift, shape.rows.length);
  const rows = [...shape.rows.slice(0, idx), ...fresh.map((p) => p.text), ...shape.rows.slice(idx)];
  const touchesEnd = idx === shape.rows.length;
  return { rows, br: shape.br, tail: touchesEnd ? !lastNoEol : shape.tail };
}

/** One unified section as one edit: a creation, a deletion, a move, or a change. */
function unifiedEdit(sec: DiffSection, strict: boolean): EditFn {
  return (tree) => {
    const oldP = sec.oldPath ?? sec.renameFrom ?? sec.gitOld;
    const newP = sec.newPath ?? sec.renameTo ?? sec.gitNew;
    const isCreate = sec.create || oldP === null;
    const isDelete = !isCreate && (sec.remove || newP === null);
    if (oldP !== null && !isSafePath(oldP)) throw new EditFault('unsafe', oldP);
    if (newP !== null && !isSafePath(newP)) throw new EditFault('unsafe', newP);
    if (isCreate) {
      if (newP === null) return;
      if (tree.read(newP) !== null) throw new EditFault('exists', newP);
      const added: string[] = [];
      let tail = true;
      for (const h of sec.hunks) {
        for (const b of h.bits) {
          if (b.kind === '+') {
            added.push(b.text);
            tail = !b.noeol;
          }
        }
      }
      tree.pending.set(newP, added.length === 0 ? '' : added.join('\n') + (tail ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (tree.read(target) === null) throw new EditFault('missing', target);
      tree.pending.set(target, null);
      return;
    }
    const src = oldP!;
    const dst = newP!;
    const before = tree.read(src);
    if (before === null) throw new EditFault('missing', src);
    if (src !== dst && tree.read(dst) !== null) throw new EditFault('exists', dst);
    let shape = readShape(before);
    let drift = 0;
    for (const h of sec.hunks) {
      shape = applyHunk(shape, h, strict, src, drift);
      drift += hunkNewLen(h) - hunkOldLen(h);
    }
    const out = writeShape(shape);
    if (src !== dst) {
      tree.pending.set(dst, out);
      tree.pending.set(src, null);
      tree.moves.push({ from: src, to: dst });
    } else {
      tree.pending.set(src, out);
    }
  };
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Parse SEARCH/REPLACE blocks. The path is the nearest line before the SEARCH line,
 *  after the previous block's REPLACE line, that is not blank and does not start with
 *  three backticks; with none, the block takes the previous block's path. */
function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (isBlank(t)) continue;
      if (t.trimStart().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new AbortRun(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let k = searchIdx + 1;
    for (; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new AbortRun(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let m = eq + 1; m < lines.length; m++) {
      if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = m;
        break;
      }
    }
    if (rep < 0) throw new AbortRun(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

/** One SEARCH/REPLACE block as one edit. Empty old lines create the file; otherwise the
 *  old lines must occur at their tier exactly once. */
function srEdit(block: SrBlock, strict: boolean): EditFn {
  return (tree) => {
    if (!isSafePath(block.path)) throw new EditFault('unsafe', block.path);
    if (block.oldLines.length === 0) {
      if (tree.read(block.path) !== null) throw new EditFault('exists', block.path);
      tree.pending.set(block.path, block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.read(block.path);
    if (before === null) throw new EditFault('missing', block.path);
    const shape = readShape(before);
    const found = firstTierWith(shape.rows, block.oldLines, strict);
    if (found === null) throw new EditFault('no-match', block.path);
    if (found.spots.length > 1) throw new EditFault('ambiguous', block.path);
    const at = found.spots[0]!;
    const fresh: FreshLine[] = block.newLines.map((t) => ({ text: t, ctx: null }));
    const rows = swapLines(shape.rows, at, block.oldLines.length, fresh, found.tier, block.oldLines[0]!);
    tree.pending.set(block.path, writeShape({ rows, br: shape.br, tail: shape.tail }));
  };
}

/** One chunk of a V4A Update File section (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  bits: BodyBit[];
  eof: boolean;
}

/** One V4A section: Add, Delete, or Update (with an optional Move to). */
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  lineNo: number;
}

/** Drop the blank lines at the end of a section, and check an Update section has a
 *  chunk or a Move to. */
function closeVSection(sec: VSection | null): void {
  if (sec === null) return;
  if (sec.kind === 'add') {
    while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
  }
  if (sec.kind === 'update') {
    const lastChunk = sec.chunks[sec.chunks.length - 1];
    if (lastChunk !== undefined) {
      while (lastChunk.bits.length > 0) {
        const last = lastChunk.bits[lastChunk.bits.length - 1]!;
        if (last.kind === ' ' && last.text === '') lastChunk.bits.pop();
        else break;
      }
    }
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new AbortRun(`error: parse ${sec.lineNo}`);
  }
}

/** Parse a V4A patch into its sections (SPEC.md section 8). */
function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new AbortRun('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new AbortRun(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new AbortRun(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let curChunk: VChunk | null = null;
  const secStart = (l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice('*** Add File: '.length).trim() };
    if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice('*** Delete File: '.length).trim() };
    if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice('*** Update File: '.length).trim() };
    return null;
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    const ss = secStart(line);
    if (ss !== null) {
      closeVSection(cur);
      cur = { kind: ss.kind, path: ss.path, moveTo: null, lines: [], chunks: [], lineNo: i + 1 };
      sections.push(cur);
      curChunk = null;
      i++;
      continue;
    }
    if (cur === null) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      throw new AbortRun(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (line === '') {
        cur.lines.push('');
        i++;
        continue;
      }
      if (line.startsWith('+')) {
        cur.lines.push(line.slice(1));
        i++;
        continue;
      }
      throw new AbortRun(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'delete') {
      if (isBlank(line)) {
        i++;
        continue;
      }
      throw new AbortRun(`error: parse ${i + 1}`);
    }
    if (line.startsWith('*** Move to: ') && cur.chunks.length === 0 && curChunk === null && cur.moveTo === null) {
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      i++;
      continue;
    }
    if (line === '*** End of File') {
      if (curChunk === null) throw new AbortRun(`error: parse ${i + 1}`);
      curChunk.eof = true;
      curChunk = null;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      curChunk = { anchor: line.slice(2).trim() || null, bits: [], eof: false };
      cur.chunks.push(curChunk);
      i++;
      continue;
    }
    if (line === '') {
      if (curChunk === null && cur.chunks.length > 0) {
        i++;
        continue;
      }
      if (curChunk === null) {
        curChunk = { anchor: null, bits: [], eof: false };
        cur.chunks.push(curChunk);
      }
      curChunk.bits.push({ kind: ' ', text: '', noeol: false });
      i++;
      continue;
    }
    if (line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (curChunk === null) {
        if (cur.chunks.length > 0) throw new AbortRun(`error: parse ${i + 1}`);
        curChunk = { anchor: null, bits: [], eof: false };
        cur.chunks.push(curChunk);
      }
      curChunk.bits.push({ kind: line[0] as ' ' | '-' | '+', text: line.slice(1), noeol: false });
      i++;
      continue;
    }
    throw new AbortRun(`error: parse ${i + 1}`);
  }
  closeVSection(cur);
  return sections;
}

/** Apply one V4A chunk: the anchor positions the cursor, then the old lines are found
 *  at or after it. Returns the new shape and the cursor just after the lines written. */
function applyVChunk(shape: FileShape, ch: VChunk, strict: boolean, path: string, cursorIn: number): { shape: FileShape; cursor: number } {
  let cursor = cursorIn;
  const rows = shape.rows;
  if (ch.anchor !== null) {
    const tiers = strict ? [0] : [0, 1, 2];
    let foundAt = -1;
    for (const t of tiers) {
      for (let k = cursor; k < rows.length; k++) {
        if (lineEqAt(rows[k]!, ch.anchor, t)) {
          foundAt = k;
          break;
        }
      }
      if (foundAt >= 0) break;
    }
    if (foundAt < 0) throw new EditFault('no-match', path);
    cursor = foundAt + 1;
  }
  const oldLines: string[] = [];
  const fresh: FreshLine[] = [];
  for (const b of ch.bits) {
    if (b.kind === ' ') {
      oldLines.push(b.text);
      fresh.push({ text: b.text, ctx: oldLines.length - 1 });
    } else if (b.kind === '-') {
      oldLines.push(b.text);
    } else {
      fresh.push({ text: b.text, ctx: null });
    }
  }
  if (oldLines.length === 0) {
    const idx = ch.eof ? rows.length : cursor;
    const added = fresh.map((p) => p.text);
    const out = [...rows.slice(0, idx), ...added, ...rows.slice(idx)];
    return { shape: { rows: out, br: shape.br, tail: shape.tail }, cursor: idx + added.length };
  }
  const found = firstTierFrom(rows, oldLines, strict, cursor);
  if (found === null) throw new EditFault('no-match', path);
  let at = found.spots[0]!;
  if (ch.eof) {
    const endSpot = found.spots.find((s) => s + oldLines.length === rows.length);
    if (endSpot === undefined) throw new EditFault('no-match', path);
    at = endSpot;
  }
  const out = swapLines(rows, at, oldLines.length, fresh, found.tier, oldLines[0]!);
  return { shape: { rows: out, br: shape.br, tail: shape.tail }, cursor: at + fresh.length };
}

/** One V4A section as one edit. */
function v4aEdit(sec: VSection, strict: boolean): EditFn {
  return (tree) => {
    if (!isSafePath(sec.path)) throw new EditFault('unsafe', sec.path);
    if (sec.moveTo !== null && !isSafePath(sec.moveTo)) throw new EditFault('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.read(sec.path) !== null) throw new EditFault('exists', sec.path);
      tree.pending.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.read(sec.path) === null) throw new EditFault('missing', sec.path);
      tree.pending.set(sec.path, null);
      return;
    }
    const before = tree.read(sec.path);
    if (before === null) throw new EditFault('missing', sec.path);
    if (sec.moveTo !== null && tree.read(sec.moveTo) !== null) throw new EditFault('exists', sec.moveTo);
    let shape = readShape(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      const r = applyVChunk(shape, ch, strict, sec.path, cursor);
      shape = r.shape;
      cursor = r.cursor;
    }
    const out = writeShape(shape);
    if (sec.moveTo !== null) {
      tree.pending.set(sec.moveTo, out);
      tree.pending.set(sec.path, null);
      tree.moves.push({ from: sec.path, to: sec.moveTo });
    } else {
      tree.pending.set(sec.path, out);
    }
  };
}

/** The driver: parse the command line, read the patch, detect and read its format,
 *  run the edits against the tree, and report (SPEC.md sections 1, 2 and 10). */
function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && (KNOWN_FORMATS as string[]).includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? sniff(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = jsonAll(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, strict));
    else edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new AbortRun('error: parse 1');
  } catch (e) {
    if (e instanceof AbortRun) return { code: 2, out: [e.text] };
    throw e;
  }
  const tree = new WorkTree();
  const faults: EditFault[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.pending);
    const snapMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.pending.clear();
      for (const [k, v] of snap) tree.pending.set(k, v);
      tree.moves.length = snapMoves;
      faults.push(e);
    }
  }
  if (faults.length > 0) {
    return { code: 1, out: [...faults.map((f) => `error: ${f.code} ${f.path}`), `failed: ${faults.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const mv of tree.moves) {
    const fromFinal = tree.pending.has(mv.from) ? tree.pending.get(mv.from)! : tree.disk(mv.from);
    const toFinal = tree.pending.has(mv.to) ? tree.pending.get(mv.to)! : tree.disk(mv.to);
    if (tree.disk(mv.from) !== null && fromFinal === null && tree.disk(mv.to) === null && toFinal !== null) {
      rows.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
      covered.add(mv.from);
      covered.add(mv.to);
      if (!checkOnly) {
        rmSync(mv.from, { force: true });
        mkdirSync(dirname(mv.to), { recursive: true });
        writeFileSync(mv.to, toFinal);
      }
    }
  }
  const touched = [...tree.pending.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of touched) {
    if (covered.has(p)) continue;
    const was = tree.disk(p);
    const now = tree.pending.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (!checkOnly) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

// Full mend implementation for hidden-spec-cli-01-run-20261122
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileState {
  br: string;
  lines: string[];
  endsWithBr: boolean;
}

function decodeFileText(text: string | null): FileState | null {
  if (text === null) return null;
  if (text === '') return { br: '\n', lines: [], endsWithBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBr = text.endsWith(br);
  const lines = text.split(br);
  if (endsWithBr) lines.pop();
  return { br, lines, endsWithBr };
}

function encodeFileState(st: FileState | null): string | null {
  if (st === null) return null;
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.endsWithBr ? st.br : '');
}

/** The tree as the edits leave it */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { oldPath: string; newPath: string }[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  getFileState(p: string): FileState | null {
    const t = this.get(p);
    return decodeFileText(t);
  }

  setFileState(p: string, st: FileState | null) {
    this.now.set(p, encodeFileState(st));
  }
}

type Edit = (tree: Tree, strict: boolean) => void;

// --- Section 5: Tier Matching ---
function matchTier(fileLine: string, oldLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oldLine;
  if (tier === 1) return fileLine.replace(/[ \t]+$/, '') === oldLine.replace(/[ \t]+$/, '');
  if (tier === 2) return fileLine.replace(/^[ \t]+|[ \t]+$/, '') === oldLine.replace(/^[ \t]+|[ \t]+$/, '');
  return false;
}

function findOccurrencesAtTier(fileLines: string[], oldLines: string[], tier: number, minIdx = 0): number[] {
  if (oldLines.length === 0) return [];
  const res: number[] = [];
  for (let i = minIdx; i <= fileLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!matchTier(fileLines[i + j], oldLines[j], tier)) {
        match = false;
        break;
      }
    }
    if (match) res.push(i);
  }
  return res;
}

function findBestTierOccurrences(fileLines: string[], oldLines: string[], strict: boolean, minIdx = 0): { tier: number; occurrences: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occs = findOccurrencesAtTier(fileLines, oldLines, t, minIdx);
    if (occs.length > 0) return { tier: t, occurrences: occs };
  }
  return null;
}

interface ReplacementItem {
  type: 'context' | 'new';
  text: string;
  oIndex?: number;
  isEmptyLine?: boolean;
}

function computeReplacedLines(
  fileLines: string[],
  matchIdx: number,
  oldLines: string[],
  nItems: ReplacementItem[],
  tier: number
): string[] {
  const F = fileLines[matchIdx]?.match(/^[ \t]*/)?.[0] ?? '';
  const P = oldLines[0]?.match(/^[ \t]*/)?.[0] ?? '';

  const outLines: string[] = [];

  for (const item of nItems) {
    if (item.type === 'context') {
      const idx = item.oIndex !== undefined ? item.oIndex : 0;
      outLines.push(fileLines[matchIdx + idx]!);
    } else {
      let l = item.text;
      if (tier === 2) {
        if (l.trim() !== '' && l.startsWith(P)) {
          l = F + l.slice(P.length);
        }
      }
      outLines.push(l);
    }
  }
  return outLines;
}

// --- Section 4: Format Detection ---
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- Section 7: SEARCH/REPLACE Blocks ---
function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;

  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLineNum = i + 1;
      let path: string | null = null;
      for (let k = i - 1; k >= 0; k--) {
        const l = lines[k]!;
        if (l.trimEnd() === '>>>>>>> REPLACE') break;
        if (!blank(l)) {
          const trimmed = l.trim();
          if (!trimmed.startsWith('```')) {
            path = trimmed;
            break;
          }
        }
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLineNum}`);
      prevPath = path;

      i++;
      const oldLines: string[] = [];
      while (i < n && lines[i]!.trimEnd() !== '=======') {
        oldLines.push(lines[i]!);
        i++;
      }
      if (i >= n) throw new Exit2(`error: parse ${searchLineNum}`);
      i++; // skip =======

      const newLines: string[] = [];
      while (i < n && lines[i]!.trimEnd() !== '>>>>>>> REPLACE') {
        newLines.push(lines[i]!);
        i++;
      }
      if (i >= n) throw new Exit2(`error: parse ${searchLineNum}`);
      i++; // skip >>>>>>> REPLACE

      const targetPath = path;
      edits.push((tree, strict) => {
        if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
        const curr = tree.getFileState(targetPath);

        if (oldLines.length === 0) {
          if (curr !== null) throw new Fail('exists', targetPath);
          tree.setFileState(targetPath, {
            br: '\n',
            lines: [...newLines],
            endsWithBr: true
          });
          return;
        }

        if (curr === null) throw new Fail('missing', targetPath);
        const matchRes = findBestTierOccurrences(curr.lines, oldLines, strict);
        if (matchRes === null) throw new Fail('no-match', targetPath);
        if (matchRes.occurrences.length > 1) throw new Fail('ambiguous', targetPath);

        const matchIdx = matchRes.occurrences[0]!;
        const replacementItems: ReplacementItem[] = newLines.map((l) => ({ type: 'new', text: l }));
        const replaced = computeReplacedLines(curr.lines, matchIdx, oldLines, replacementItems, matchRes.tier);

        curr.lines.splice(matchIdx, oldLines.length, ...replaced);
        tree.setFileState(targetPath, curr);
      });
      continue;
    }
    i++;
  }

  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// --- Section 8: V4A Patches ---
function parseV4A(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const edits: Edit[] = [];
  let i = first + 1;

  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice(14).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last && !lines[i]!.startsWith('*** ')) {
        const bl = lines[i]!;
        if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else if (bl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.setFileState(p, {
          br: '\n',
          lines: fileLines,
          endsWithBr: true
        });
      });
      continue;
    }

    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice(17).trim();
      i++;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }

    if (l.startsWith('*** Update File: ')) {
      const updateLineNum = i + 1;
      const oldPath = l.slice(17).trim();
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }

      interface V4AChunk {
        anchor: string | null;
        isEof: boolean;
        oLines: string[];
        nItems: ReplacementItem[];
      }
      const chunks: V4AChunk[] = [];

      while (i < last && !lines[i]!.startsWith('*** Add File: ') && !lines[i]!.startsWith('*** Delete File: ') && !lines[i]!.startsWith('*** Update File: ')) {
        if (blank(lines[i]!)) {
          let allBlank = true;
          for (let k = i; k < last; k++) {
            if (!blank(lines[k]!)) {
              if (lines[k]!.startsWith('*** ')) allBlank = true;
              else allBlank = false;
              break;
            }
          }
          if (allBlank) break;
        }

        let anchor: string | null = null;
        let isEof = false;

        if (lines[i]!.startsWith('@@')) {
          const rawAnchor = lines[i]!.slice(2).trim();
          anchor = rawAnchor !== '' ? rawAnchor : null;
          i++;
        }

        const oLines: string[] = [];
        const nItems: ReplacementItem[] = [];
        let curOIndex = 0;

        while (i < last) {
          const bl = lines[i]!;
          if (bl === '*** End of File') {
            isEof = true;
            i++;
            break;
          }
          if (bl.startsWith('@@') || bl.startsWith('*** ')) break;
          if (bl.startsWith(' ')) {
            const text = bl.slice(1);
            oLines.push(text);
            nItems.push({ type: 'context', text, oIndex: curOIndex });
            curOIndex++;
          } else if (bl === '') {
            oLines.push('');
            nItems.push({ type: 'context', text: '', oIndex: curOIndex, isEmptyLine: true });
            curOIndex++;
          } else if (bl.startsWith('-')) {
            oLines.push(bl.slice(1));
            curOIndex++;
          } else if (bl.startsWith('+')) {
            nItems.push({ type: 'new', text: bl.slice(1) });
          } else {
            throw new Exit2(`error: parse ${i + 1}`);
          }
          i++;
        }

        // Blank lines at the end of a section (before the next section or *** End Patch) are not part of it
        if (i >= last || lines[i]!.startsWith('*** ')) {
          while (
            nItems.length > 0 &&
            nItems[nItems.length - 1]!.type === 'context' &&
            nItems[nItems.length - 1]!.text.trim() === ''
          ) {
            nItems.pop();
            oLines.pop();
          }
        }

        chunks.push({ anchor, isEof, oLines, nItems });
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${updateLineNum}`);
      }

      edits.push((tree, strict) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);

        const curr = tree.getFileState(oldPath);
        if (curr === null) throw new Fail('missing', oldPath);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let anchorIdx = -1;
            const maxTier = strict ? 0 : 2;
            for (let t = 0; t <= maxTier; t++) {
              for (let idx = cursor; idx < curr.lines.length; idx++) {
                if (matchTier(curr.lines[idx]!, ch.anchor, t)) {
                  anchorIdx = idx;
                  break;
                }
              }
              if (anchorIdx >= 0) break;
            }
            if (anchorIdx < 0) throw new Fail('no-match', oldPath);
            cursor = anchorIdx + 1;
          }

          if (ch.oLines.length === 0) {
            const insLines = ch.nItems.map((item) => item.text);
            if (ch.isEof) {
              curr.lines.push(...insLines);
              cursor = curr.lines.length;
            } else {
              curr.lines.splice(cursor, 0, ...insLines);
              cursor += insLines.length;
            }
            continue;
          }

          const matchRes = findBestTierOccurrences(curr.lines, ch.oLines, strict, cursor);
          if (matchRes === null) throw new Fail('no-match', oldPath);

          let chosenIdx: number;
          if (ch.isEof) {
            const eofOcc = matchRes.occurrences.find((idx) => idx + ch.oLines.length === curr.lines.length);
            if (eofOcc === undefined) throw new Fail('no-match', oldPath);
            chosenIdx = eofOcc;
          } else {
            chosenIdx = matchRes.occurrences[0]!;
          }

          const replaced = computeReplacedLines(curr.lines, chosenIdx, ch.oLines, ch.nItems, matchRes.tier);
          curr.lines.splice(chosenIdx, ch.oLines.length, ...replaced);
          cursor = chosenIdx + replaced.length;
        }

        if (moveTo !== null) {
          tree.now.set(oldPath, null);
          tree.setFileState(moveTo, curr);
          tree.moves.push({ oldPath, newPath: moveTo });
        } else {
          tree.setFileState(oldPath, curr);
        }
      });
      continue;
    }

    throw new Exit2(`error: parse ${i + 1}`);
  }

  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// --- Section 6: Unified Diffs ---
interface UnifiedHunk {
  a: number; // 1-based old line
  b?: number;
  c: number;
  d?: number;
  oLines: string[];
  nItems: ReplacementItem[];
  noeol: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    if (lines[i]!.startsWith('diff --git ')) {
      const diffLineNum = i + 1;
      const m = /^diff --git a\/(\S+)\s+b\/(\S+)/.exec(lines[i]!);
      if (!m) throw new Exit2(`error: parse ${diffLineNum}`);
      let oldPath: string | null = m[1]!;
      let newPath: string | null = m[2]!;
      let isCreate = false;
      let isDelete = false;

      i++;
      let sawHeaderPaths = false;
      while (i < n && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('diff --git ')) {
        const l = lines[i]!;
        if (l.startsWith('new file mode')) {
          isCreate = true;
          i++;
        } else if (l.startsWith('deleted file mode')) {
          isDelete = true;
          i++;
        } else if (l.startsWith('rename from ')) {
          oldPath = l.slice(12).trim();
          i++;
        } else if (l.startsWith('rename to ')) {
          newPath = l.slice(10).trim();
          i++;
        } else if (l.startsWith('--- ')) {
          if (sawHeaderPaths) {
            break;
          }
          if (i + 1 >= n || !lines[i + 1]!.startsWith('+++ ')) {
            throw new Exit2(`error: parse ${i + 2}`);
          }
          const rawOld = lines[i]!.slice(4).split('\t')[0]!.trim();
          const rawNew = lines[i + 1]!.slice(4).split('\t')[0]!.trim();
          oldPath = cleanDiffPath(rawOld);
          newPath = cleanDiffPath(rawNew);
          sawHeaderPaths = true;
          i += 2;
        } else {
          i++;
        }
      }

      if (oldPath === null) isCreate = true;
      if (newPath === null) isDelete = true;

      const hunks = parseHunks();
      sections.push({ oldPath, newPath, isCreate, isDelete, hunks });
      continue;
    }

    if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const rawOld = lines[i]!.slice(4).split('\t')[0]!.trim();
      const rawNew = lines[i + 1]!.slice(4).split('\t')[0]!.trim();
      const oldPath = cleanDiffPath(rawOld);
      const newPath = cleanDiffPath(rawNew);
      const isCreate = oldPath === null;
      const isDelete = newPath === null;
      i += 2;

      const hunks = parseHunks();
      sections.push({ oldPath, newPath, isCreate, isDelete, hunks });
      continue;
    }

    if (lines[i]!.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    }

    i++;
  }

  function cleanDiffPath(p: string): string | null {
    if (p === '/dev/null') return null;
    if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
    return p;
  }

  function parseHunks(): UnifiedHunk[] {
    const hunks: UnifiedHunk[] = [];
    while (i < n) {
      if (lines[i]!.startsWith('diff --git ') || (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        break;
      }
      if (!lines[i]!.startsWith('@@')) {
        let nextHunkIdx = -1;
        for (let k = i; k < n; k++) {
          if (lines[k]!.startsWith('diff --git ') || (lines[k]!.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ '))) {
            break;
          }
          if (lines[k]!.startsWith('@@')) {
            nextHunkIdx = k;
            break;
          }
        }
        if (nextHunkIdx !== -1) {
          i = nextHunkIdx;
        } else {
          break;
        }
      }

      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]!);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const c = parseInt(m[2]!, 10);
      i++;

      const oLines: string[] = [];
      const nItems: ReplacementItem[] = [];
      let lastNewOrContextHadNoeol = false;
      let curOIndex = 0;

      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('@@') || bl.startsWith('diff --git ') || (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
          break;
        }
        if (bl.startsWith(' ')) {
          const text = bl.slice(1);
          oLines.push(text);
          nItems.push({ type: 'context', text, oIndex: curOIndex });
          curOIndex++;
          lastNewOrContextHadNoeol = false;
        } else if (bl === '') {
          oLines.push('');
          nItems.push({ type: 'context', text: '', oIndex: curOIndex, isEmptyLine: true });
          curOIndex++;
          lastNewOrContextHadNoeol = false;
        } else if (bl.startsWith('-')) {
          oLines.push(bl.slice(1));
          curOIndex++;
        } else if (bl.startsWith('+')) {
          nItems.push({ type: 'new', text: bl.slice(1) });
          lastNewOrContextHadNoeol = false;
        } else if (bl.startsWith('\\')) {
          const prev = lines[i - 1] ?? '';
          if (prev.startsWith('+') || prev.startsWith(' ') || prev === '') {
            lastNewOrContextHadNoeol = true;
          }
        } else {
          break;
        }
        i++;
      }

      while (
        oLines.length > 0 &&
        nItems.length > 0 &&
        nItems[nItems.length - 1]!.isEmptyLine
      ) {
        oLines.pop();
        nItems.pop();
      }

      hunks.push({ a, c, oLines, nItems, noeol: lastNewOrContextHadNoeol });
    }
    return hunks;
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const sec of sections) {
    edits.push((tree, strict) => {
      if (sec.isCreate) {
        const p = sec.newPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);

        const createdLines: string[] = [];
        let finalNoNewline = false;
        for (const h of sec.hunks) {
          for (const item of h.nItems) {
            if (item.type === 'new') createdLines.push(item.text);
          }
          if (h.noeol) finalNoNewline = true;
        }
        tree.setFileState(p, {
          br: '\n',
          lines: createdLines,
          endsWithBr: !finalNoNewline
        });
        return;
      }

      if (sec.isDelete) {
        const p = sec.oldPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }

      const isMove = sec.oldPath !== sec.newPath;
      const oldP = sec.oldPath!;
      const newP = sec.newPath!;

      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (isMove && !safe(newP)) throw new Fail('unsafe', newP);

      const curr = tree.getFileState(oldP);
      if (curr === null) throw new Fail('missing', oldP);
      if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);

      let d = 0;
      for (const h of sec.hunks) {
        const oLen = h.oLines.length;
        const nLen = h.nItems.length;

        if (oLen > 0) {
          const matchRes = findBestTierOccurrences(curr.lines, h.oLines, strict);
          if (matchRes === null) throw new Fail('no-match', oldP);

          const targetLine = h.a - 1 + d;
          let bestIdx = matchRes.occurrences[0]!;
          let minDiff = Math.abs(bestIdx - targetLine);

          for (let k = 1; k < matchRes.occurrences.length; k++) {
            const idx = matchRes.occurrences[k]!;
            const diff = Math.abs(idx - targetLine);
            if (diff < minDiff) {
              minDiff = diff;
              bestIdx = idx;
            }
          }

          const runsToEnd = bestIdx + oLen === curr.lines.length;
          const replaced = computeReplacedLines(curr.lines, bestIdx, h.oLines, h.nItems, matchRes.tier);
          curr.lines.splice(bestIdx, oLen, ...replaced);

          if (runsToEnd) {
            curr.endsWithBr = !h.noeol;
          }
        } else {
          // Empty O
          const insIdx = Math.min(curr.lines.length, Math.max(0, h.a + d));
          const runsToEnd = insIdx === curr.lines.length;
          const insLines = h.nItems.map((item) => item.text);
          curr.lines.splice(insIdx, 0, ...insLines);

          if (runsToEnd) {
            curr.endsWithBr = !h.noeol;
          }
        }
        d += nLen - oLen;
      }

      if (isMove) {
        tree.now.set(oldP, null);
        tree.setFileState(newP, curr);
        tree.moves.push({ oldPath: oldP, newPath: newP });
      } else {
        tree.setFileState(oldP, curr);
      }
    });
  }

  return edits;
}

// --- Section 9: JSON edits ---
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

export function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else if (kind === 'v4a') edits = parseV4A(lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else throw new Exit2('error: format');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`]
    };
  }

  // Generate output rows
  const moveMap = new Map<string, string>(); // newPath -> oldPath
  for (const m of tree.moves) {
    if (tree.original(m.oldPath) !== null && tree.now.get(m.oldPath) === null &&
        tree.original(m.newPath) === null && tree.now.get(m.newPath) !== null) {
      moveMap.set(m.newPath, m.oldPath);
    }
  }

  interface Row {
    sortKey: string;
    text: string;
  }
  const rows: Row[] = [];
  const handled = new Set<string>();

  for (const p of tree.now.keys()) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;

    if (moveMap.has(p)) {
      const oldP = moveMap.get(p)!;
      rows.push({ sortKey: p, text: `R ${oldP} -> ${p}` });
      handled.add(p);
      handled.add(oldP);
      continue;
    }

    let isOldOfMove = false;
    for (const [newP, oldP] of moveMap.entries()) {
      if (oldP === p) {
        isOldOfMove = true;
        break;
      }
    }
    if (isOldOfMove) continue;

    rows.push({
      sortKey: p,
      text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`
    });
    handled.add(p);
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));

  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  const outLines = rows.map((r) => r.text);
  return {
    code: 0,
    out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`]
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

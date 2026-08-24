export type TerminalSelectionScrollDirection = 'down' | 'up';

interface SelectionOverlap {
  accumulatedStart: number;
  snapshotStart: number;
}

interface SelectionOverlapCandidate extends SelectionOverlap {
  characterCount: number;
  lineCount: number;
  nonBlankLines: number;
}

interface LineOverlapState {
  characterCounts: number[];
  lengths: number[];
  nonBlankCounts: number[];
}

/**
 * Merge consecutive selections from a repainting alternate-screen TUI.
 *
 * Full-screen apps redraw fixed headers and footers around a moving body, so a
 * simple suffix/prefix comparison is insufficient. Consecutive scroll frames
 * still share at least two body rows; use that meaningful contiguous overlap
 * and keep only one copy of the stable chrome. Returning null is intentional:
 * when frames cannot be aligned unambiguously, the caller must use an
 * authoritative source or cancel instead of silently fabricating text.
 */
export function accumulateScrolledTerminalSelection(
  accumulatedText: string,
  snapshotText: string,
  direction: TerminalSelectionScrollDirection,
): string | null {
  const accumulated = normalizeText(accumulatedText);
  const snapshot = normalizeText(snapshotText);
  if (!accumulated || !snapshot) return null;
  if (accumulated === snapshot) return accumulated;

  const accumulatedLines = accumulated.split('\n');
  const snapshotLines = snapshot.split('\n');
  if (isSelectionExpandedToViewportEdge(accumulatedLines, snapshotLines, direction)) {
    return snapshot;
  }
  if (isViewportAtSelectionEdge(accumulatedLines, snapshotLines, direction)) {
    return accumulated;
  }
  const snapshotCoverage = getSnapshotCoverage(accumulatedLines, snapshotLines);
  if (snapshotCoverage === 'covered') return accumulated;
  if (snapshotCoverage === 'ambiguous') return null;
  const overlapWindowSize = Math.max(2, snapshotLines.length * 2);
  const accumulatedWindowStart = direction === 'down'
    ? Math.max(0, accumulatedLines.length - overlapWindowSize)
    : 0;
  const accumulatedWindow = accumulatedLines.slice(
    accumulatedWindowStart,
    direction === 'down' ? undefined : overlapWindowSize,
  );
  const overlap = findMeaningfulLineOverlap(accumulatedWindow, snapshotLines, direction);
  if (!overlap) return null;

  const accumulatedStart = accumulatedWindowStart + overlap.accumulatedStart;
  const mergedLines = direction === 'down'
    ? [
        ...accumulatedLines.slice(0, accumulatedStart),
        ...snapshotLines.slice(overlap.snapshotStart),
      ]
    : [
        ...snapshotLines.slice(0, overlap.snapshotStart),
        ...accumulatedLines.slice(accumulatedStart),
      ];
  return mergedLines.join('\n');
}

function isSelectionExpandedToViewportEdge(
  accumulatedLines: string[],
  snapshotLines: string[],
  direction: TerminalSelectionScrollDirection,
): boolean {
  if (snapshotLines.length <= accumulatedLines.length) return false;
  const snapshotStart = direction === 'down'
    ? 0
    : snapshotLines.length - accumulatedLines.length;
  return accumulatedLines.every((line, index) => line === snapshotLines[snapshotStart + index]);
}

export function expandScrolledTerminalSelection(
  capturedText: string,
  anchorText: string,
  currentText: string,
  direction: TerminalSelectionScrollDirection,
): string | null {
  const capture = normalizeText(capturedText);
  const anchor = normalizeText(anchorText);
  const current = normalizeText(currentText);
  if (!capture || !anchor || !current) return null;

  return direction === 'down'
    ? findUniqueDownInterval(capture, anchor, current)
    : findUniqueUpInterval(capture, anchor, current);
}

function findUniqueDownInterval(capture: string, anchor: string, current: string): string | null {
  const anchorStart = capture.indexOf(anchor);
  if (anchorStart < 0) return null;
  const minimumStartGap = Math.max(0, anchor.length - current.length);
  const currentStart = capture.indexOf(current, anchorStart + minimumStartGap);
  if (currentStart < 0) return null;

  const secondAnchorStart = capture.indexOf(anchor, anchorStart + 1);
  const secondCurrentStart = capture.indexOf(current, currentStart + 1);
  if (
    (secondAnchorStart >= 0 && secondAnchorStart <= currentStart - minimumStartGap)
    || secondCurrentStart >= 0
  ) return null;

  return capture.slice(anchorStart, currentStart + current.length);
}

function findUniqueUpInterval(capture: string, anchor: string, current: string): string | null {
  const currentStart = capture.indexOf(current);
  if (currentStart < 0) return null;
  const minimumStartGap = Math.max(0, current.length - anchor.length);
  const anchorStart = capture.indexOf(anchor, currentStart + minimumStartGap);
  if (anchorStart < 0) return null;

  const secondCurrentStart = capture.indexOf(current, currentStart + 1);
  const secondAnchorStart = capture.indexOf(anchor, anchorStart + 1);
  if (
    (secondCurrentStart >= 0 && secondCurrentStart <= anchorStart - minimumStartGap)
    || secondAnchorStart >= 0
  ) return null;

  return capture.slice(currentStart, anchorStart + anchor.length);
}

function normalizeText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  return normalized.replace(/[^\S\n]+/g, (whitespace, offset) => (
    offset + whitespace.length === normalized.length
      || normalized[offset + whitespace.length] === '\n'
      ? ''
      : whitespace
  ));
}

function findMeaningfulLineOverlap(
  accumulatedLines: string[],
  snapshotLines: string[],
  direction: TerminalSelectionScrollDirection,
): SelectionOverlap | null {
  let previous = createLineOverlapState(snapshotLines.length);
  const candidates: SelectionOverlapCandidate[] = [];

  for (let accumulatedIndex = 0; accumulatedIndex < accumulatedLines.length; accumulatedIndex += 1) {
    const current = createLineOverlapState(snapshotLines.length);
    for (let snapshotIndex = 0; snapshotIndex < snapshotLines.length; snapshotIndex += 1) {
      if (accumulatedLines[accumulatedIndex] !== snapshotLines[snapshotIndex]) continue;
      const candidate = extendLineOverlap(
        previous,
        current,
        accumulatedIndex,
        snapshotIndex,
        accumulatedLines[accumulatedIndex],
      );
      if (isMeaningfulOverlap(
        candidate,
        accumulatedLines,
        snapshotLines,
        direction,
      )) candidates.push(candidate);
    }
    previous = current;
  }

  return selectUnambiguousOverlap(candidates, direction);
}

function createLineOverlapState(lineCount: number): LineOverlapState {
  const size = lineCount + 1;
  return {
    characterCounts: new Array<number>(size).fill(0),
    lengths: new Array<number>(size).fill(0),
    nonBlankCounts: new Array<number>(size).fill(0),
  };
}

function extendLineOverlap(
  previous: LineOverlapState,
  current: LineOverlapState,
  accumulatedIndex: number,
  snapshotIndex: number,
  line: string,
): SelectionOverlapCandidate {
  const lineCount = previous.lengths[snapshotIndex] + 1;
  const characterCount = previous.characterCounts[snapshotIndex] + line.length;
  const nonBlankLines = previous.nonBlankCounts[snapshotIndex] + (line.trim().length > 0 ? 1 : 0);
  current.lengths[snapshotIndex + 1] = lineCount;
  current.characterCounts[snapshotIndex + 1] = characterCount;
  current.nonBlankCounts[snapshotIndex + 1] = nonBlankLines;
  return {
    accumulatedStart: accumulatedIndex - lineCount + 1,
    characterCount,
    lineCount,
    nonBlankLines,
    snapshotStart: snapshotIndex - lineCount + 1,
  };
}

function isMeaningfulOverlap(
  candidate: SelectionOverlapCandidate,
  accumulatedLines: string[],
  snapshotLines: string[],
  direction: TerminalSelectionScrollDirection,
): boolean {
  return candidate.nonBlankLines >= 2
    && movesWithScroll(candidate, direction)
    && extendsSelection(candidate, accumulatedLines, snapshotLines, direction);
}

function isViewportAtSelectionEdge(
  accumulatedLines: string[],
  snapshotLines: string[],
  direction: TerminalSelectionScrollDirection,
): boolean {
  if (snapshotLines.length >= accumulatedLines.length) return false;
  const accumulatedStart = direction === 'up'
    ? 0
    : accumulatedLines.length - snapshotLines.length;
  return snapshotLines.every((line, index) => line === accumulatedLines[accumulatedStart + index]);
}

function getSnapshotCoverage(
  accumulatedLines: string[],
  snapshotLines: string[],
): 'ambiguous' | 'covered' | 'not-covered' {
  if (snapshotLines.length >= accumulatedLines.length) return 'not-covered';
  let prefixLength = 0;
  while (
    prefixLength < snapshotLines.length
    && accumulatedLines[prefixLength] === snapshotLines[prefixLength]
  ) prefixLength += 1;

  let suffixLength = 0;
  while (
    suffixLength < snapshotLines.length - prefixLength
    && accumulatedLines[accumulatedLines.length - suffixLength - 1]
      === snapshotLines[snapshotLines.length - suffixLength - 1]
  ) suffixLength += 1;

  const snapshotBody = snapshotLines.slice(
    prefixLength,
    snapshotLines.length - suffixLength,
  );
  if (snapshotBody.length === 0) {
    return prefixLength + suffixLength > 0 ? 'covered' : 'not-covered';
  }

  const lastStart = accumulatedLines.length - suffixLength - snapshotBody.length;
  let matchCount = 0;
  for (let start = prefixLength; start <= lastStart; start += 1) {
    if (!snapshotBody.every((line, index) => line === accumulatedLines[start + index])) continue;
    matchCount += 1;
    if (matchCount > 1) return 'ambiguous';
  }
  return matchCount === 1 ? 'covered' : 'not-covered';
}

function selectUnambiguousOverlap(
  candidates: SelectionOverlapCandidate[],
  direction: TerminalSelectionScrollDirection,
): SelectionOverlap | null {
  if (candidates.length === 0) return null;
  // True document overlap enters at the leading edge of the newly revealed
  // frame. Filter on that invariant before overlap size: after an earlier merge,
  // fixed chrome has shifted inside the accumulator and can otherwise look
  // like a longer scrolling match.
  const leadingEdge = candidates.reduce(
    (current, candidate) => Math.min(current, getLeadingEdge(candidate, direction)),
    Number.POSITIVE_INFINITY,
  );
  const leadingCandidates = candidates.filter(
    (candidate) => getLeadingEdge(candidate, direction) === leadingEdge,
  );
  const joinEdge = getJoinEdge(leadingCandidates[0], direction);
  if (leadingCandidates.some((candidate) => getJoinEdge(candidate, direction) !== joinEdge)) {
    return null;
  }

  // Nested matches inside adjacent identical rows share one physical join
  // edge. Keep the maximal candidate. Repeated blocks at different edges are
  // genuinely ambiguous and were rejected above rather than guessed.
  const best = leadingCandidates.reduce((current, candidate) => (
    isStrongerOverlap(candidate, current) ? candidate : current
  ));
  return {
    accumulatedStart: best.accumulatedStart,
    snapshotStart: best.snapshotStart,
  };
}

function getLeadingEdge(
  candidate: SelectionOverlapCandidate,
  direction: TerminalSelectionScrollDirection,
): number {
  return direction === 'down' ? candidate.snapshotStart : candidate.accumulatedStart;
}

function getJoinEdge(
  candidate: SelectionOverlapCandidate,
  direction: TerminalSelectionScrollDirection,
): number {
  return direction === 'down'
    ? candidate.accumulatedStart + candidate.lineCount
    : candidate.snapshotStart + candidate.lineCount;
}

function isStrongerOverlap(
  candidate: SelectionOverlapCandidate,
  current: SelectionOverlapCandidate,
): boolean {
  if (candidate.nonBlankLines !== current.nonBlankLines) {
    return candidate.nonBlankLines > current.nonBlankLines;
  }
  if (candidate.lineCount !== current.lineCount) return candidate.lineCount > current.lineCount;
  return candidate.characterCount > current.characterCount;
}

function extendsSelection(
  overlap: SelectionOverlapCandidate,
  accumulatedLines: string[],
  snapshotLines: string[],
  direction: TerminalSelectionScrollDirection,
): boolean {
  const accumulatedEnd = overlap.accumulatedStart + overlap.lineCount;
  const snapshotEnd = overlap.snapshotStart + overlap.lineCount;
  if (
    accumulatedEnd < accumulatedLines.length
    && snapshotEnd < snapshotLines.length
    && accumulatedLines[accumulatedEnd] === snapshotLines[snapshotEnd]
  ) return false;

  // A real downward frame contributes a suffix after the overlap; a real
  // upward frame leaves an existing suffix after the overlap. Fixed footer
  // chrome ends at the corresponding edge. Requiring a maximal match above
  // also prevents accepting a truncated prefix of that same footer.
  return direction === 'down'
    ? snapshotEnd < snapshotLines.length
    : accumulatedEnd < accumulatedLines.length;
}

function movesWithScroll(
  overlap: SelectionOverlap,
  direction: TerminalSelectionScrollDirection,
): boolean {
  return direction === 'down'
    ? overlap.accumulatedStart > overlap.snapshotStart
    : overlap.snapshotStart > overlap.accumulatedStart;
}

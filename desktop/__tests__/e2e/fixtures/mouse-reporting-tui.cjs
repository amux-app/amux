const { writeFileSync } = require('node:fs');

const eventLogPath = process.argv[2];
const statsPath = process.argv[3];
const lines = Array.from(
  { length: 90 },
  (_, index) => `AUMX-MOUSE-TUI-LINE-${String(index + 1).padStart(3, '0')}`,
);
const mouseModesOn = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';
const mouseModesOff = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
const eventCounts = Object.create(null);
const eventLog = [];
let exiting = false;
let flushPending = false;
let input = '';
let mouseReporting = true;
let renderedRows = 0;
let silentEdge = false;
let top = 0;
const topHistory = [];

function scheduleFlush() {
  if (flushPending || !eventLogPath) return;
  flushPending = true;
  setImmediate(() => {
    flushPending = false;
    writeFileSync(eventLogPath, eventLog.map((entry) => entry.type).join('\n'));
  });
}

function record(eventType) {
  eventCounts[eventType] = (eventCounts[eventType] || 0) + 1;
  eventLog.push({ ts: Date.now(), type: eventType, top });
  scheduleFlush();
}

function dumpCounts() {
  if (statsPath) writeFileSync(statsPath, JSON.stringify({ counts: eventCounts, topHistory }));
}

function visibleRows() {
  return Math.max(3, Math.min(lines.length + 2, process.stdout.rows || 24));
}

function maxTop() {
  return Math.max(0, lines.length - Math.max(1, visibleRows() - 2));
}

function render() {
  const rows = visibleRows();
  const bodyRows = Math.max(1, rows - 2);
  top = Math.max(0, Math.min(lines.length - bodyRows, top));
  renderedRows = rows;
  const frame = [
    'AUMX-MOUSE-TUI-HEADER',
    ...lines.slice(top, top + bodyRows),
    'AUMX-MOUSE-TUI-FOOTER',
  ];
  process.stdout.write('\x1b[2J\x1b[H' + frame.join('\r\n'));
  topHistory.push({ ts: Date.now(), top });
}

function scrollBy(delta, eventType) {
  const next = Math.max(0, Math.min(maxTop(), top + delta));
  record(eventType);
  if (silentEdge && next === top) return;
  top = next;
  render();
}

function resetTo(position) {
  top = position === 'top' ? 0 : maxTop();
  record('reset:' + position);
  render();
}

function setMouseReporting(enabled) {
  mouseReporting = enabled;
  process.stdout.write(enabled ? mouseModesOn : mouseModesOff);
  record(enabled ? 'mode:on' : 'mode:off');
}

function finish() {
  if (exiting) return;
  exiting = true;
  clearInterval(resizeTimer);
  if (eventLogPath) writeFileSync(eventLogPath, eventLog.map((entry) => entry.type).join('\n'));
  dumpCounts();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(
    mouseModesOff + '\x1b[?25h\x1b[?1049l',
    () => process.exit(0),
  );
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\x1b[?1049h\x1b[?25l');
setMouseReporting(true);
render();
process.stdout.on('resize', render);
const resizeTimer = setInterval(() => {
  if (visibleRows() !== renderedRows) render();
}, 50);

function handleMouseReport(rawButton, suffix) {
  const button = Number.parseInt(rawButton, 10);
  if ((button & 65) === 64) {
    scrollBy(-1, 'wheel:up');
  } else if ((button & 65) === 65) {
    scrollBy(1, 'wheel:down');
  } else if (suffix === 'm') {
    record('mouse:release');
  } else if ((button & 32) !== 0) {
    record('mouse:move');
  } else {
    record('mouse:press');
  }
}

function handleCommand(char) {
  if (char === 'm') {
    setMouseReporting(!mouseReporting);
    render();
  } else if (char === 'g') {
    resetTo('top');
  } else if (char === 'G') {
    resetTo('bottom');
  } else if (char === 'e') {
    silentEdge = !silentEdge;
    record(silentEdge ? 'silent-edge:on' : 'silent-edge:off');
  } else if (char === 'c') {
    dumpCounts();
  }
}

process.stdin.on('data', (data) => {
  input += data.toString('binary');
  input = input.replace(/\x1b\[<(\d+);\d+;\d+([mM])/g, (_match, rawButton, suffix) => {
    handleMouseReport(rawButton, suffix);
    return '';
  });
  if (input.includes('q') || input.includes('\x03')) return finish();
  for (const char of ['m', 'g', 'G', 'e', 'c']) {
    if (!input.includes(char)) continue;
    input = input.split(char).join('');
    handleCommand(char);
  }
  if (input.length > 64) input = input.slice(-64);
});

process.on('SIGTERM', finish);

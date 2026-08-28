// tui.js — 自研的最小终端 UI 引擎，替换 blessed。
// 思路（复制 claude-code）：进入 alt 屏 + raw 模式，自己维护内存状态，
// 每一帧绘制完毕后，根据输入框的内存光标坐标算出绝对屏幕位置，用 CUP 把硬件光标钉过去。
// 支持中文等宽字符（wcwidth）。
import process from "node:process";

/* ============ 宽字符宽度 ============ */
export function wcwidth(ch) {
  const code = ch.codePointAt(0);
  if (code === 0) return 0;
  if (code < 0x20 || code === 0x7f) return 0;
  if (code === 0x3000) return 2;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x3096) ||
    (code >= 0x30a0 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += wcwidth(ch);
  return w;
}

/* ============ 颜色标签 {#rrggbb-fg} {/} -> 真 ANSI ============ */
export function tagsToAnsi(s) {
  s = String(s);
  s = s.replace(/\{\/}/g, "\x1b[0m");
  s = s.replace(/\{#([0-9a-fA-F]{6})-(fg|bg)\}/g, (_, hex, kind) => {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return kind === "fg" ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[48;2;${r};${g};${b}m`;
  });
  s = s.replace(/\{\{/g, "{").replace(/\}\}/g, "}");
  return s;
}

function clampInt(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n | 0));
}

/* ============ 屏幕网格 ============ */
function makeGrid(h, w) {
  const g = new Array(h);
  for (let r = 0; r < h; r++) {
    const row = new Array(w);
    for (let c = 0; c < w; c++) row[c] = { ch: " ", s: "" };
    g[r] = row;
  }
  return g;
}

function writeCells(grid, row, col, ansi, w) {
  if (row < 0 || row >= grid.length) return;
  let st = "";
  const re = /(\x1b\[[0-9;]*m)|([^\x1b]+)/g;
  let m;
  let x = col;
  while ((m = re.exec(ansi))) {
    if (m[1]) {
      st = m[1] === "\x1b[0m" ? "" : st + m[1];
    } else {
      const text = m[2];
      for (const ch of text) {
        const wch = ch === "\n" || ch === "\r" ? 1 : wcwidth(ch);
        if (x >= w) break;
        grid[row][x] = { ch: ch === "\n" || ch === "\r" ? " " : ch, s: st };
        if (wch === 2 && x + 1 < w) grid[row][x + 1] = { ch: " ", s: "" };
        x += wch || 1;
      }
    }
  }
}

/* ============ 按键解析（raw 模式） ============ */
export function mapEscape(p) {
  let m = /^\x1b\[(\d*)(?:;(\d*))?([A-Za-z~])/.exec(p);
  if (m) {
    const code = m[3];
    const num = m[1];
    const adv = m[0].length;
    let name = null;
    let shift = false;
    if (code === "A") name = "up";
    else if (code === "B") name = "down";
    else if (code === "C") name = "right";
    else if (code === "D") name = "left";
    else if (code === "H") name = "home";
    else if (code === "F") name = "end";
    else if (code === "Z") { name = "tab"; shift = true; }
    else if (code === "~") {
      if (num === "3") name = "delete";
      else if (num === "5") name = "pageup";
      else if (num === "6") name = "pagedown";
    }
    return shift ? { adv, name, shift } : { adv, name };
  }
  m = /^\x1bO([A-D])/.exec(p);
  if (m) return { adv: m[0].length, name: { A: "up", B: "down", C: "right", D: "left" }[m[1]] };
  return null;
}

export function feed(screen, str) {
  const h = screen._keypress;
  if (!h) return;
  screen._pending += str;
  let guard = 0;
  while (screen._pending.length && guard++ < 10000) {
    const p = screen._pending;
    const c0 = p[0];
    const emit = (ch, key) => h(ch, key);
    if (c0 === "\x03") {
      screen._pending = p.slice(1);
      emit(undefined, { name: "c", ctrl: true });
      continue;
    }
    if (c0 === "\r" || c0 === "\n") {
      screen._pending = p.slice(1);
      emit(undefined, { name: "enter" });
      continue;
    }
    if (c0 === "\x7f" || c0 === "\b") {
      screen._pending = p.slice(1);
      emit(undefined, { name: "backspace" });
      continue;
    }
    if (c0 === "\t") {
      screen._pending = p.slice(1);
      emit(undefined, { name: "tab" });
      continue;
    }
    const code = p.charCodeAt(0);
    if (code >= 1 && code <= 26 && code !== 9 && code !== 10 && code !== 13) {
      screen._pending = p.slice(1);
      emit(undefined, { name: String.fromCharCode(code + 0x60), ctrl: true });
      continue;
    }
    if (c0 === "\x1b") {
      if (p.startsWith("\x1b[200~")) {
        const end = p.indexOf("\x1b[201~");
        if (end === -1) break;
        const chunk = p.slice(6, end);
        screen._pending = p.slice(end + 6);
        emit(chunk, { name: "paste" });
        continue;
      }
      if (p.startsWith("\x1b[<")) {
        const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(p);
        if (m) {
          const code = parseInt(m[1], 10);
          const x = parseInt(m[2], 10) - 1;
          const y = parseInt(m[3], 10) - 1;
          const down = m[4] === "M";
          screen._pending = p.slice(m[0].length);
          let wheel = 0;
          if (code === 64) wheel = -1;
          else if (code === 65) wheel = 1;
          emit(undefined, { name: "mouse", button: code, x, y, down, wheel });
          continue;
        }
        break;
      }
      const r = mapEscape(p);
      if (r) {
        screen._pending = p.slice(r.adv);
        if (r.name) emit(undefined, r.shift ? { name: r.name, shift: true } : { name: r.name });
        else emit(undefined, { name: "escape" });
        continue;
      }
      // 不是完整转义序列：按 Esc 处理（兼顾单独按 Esc 的响应；极少情况下分片序列可能误判）
      screen._pending = p.slice(1);
      emit(undefined, { name: "escape" });
      continue;
    }
    const ch = Array.from(p)[0];
    screen._pending = p.slice(ch.length);
    emit(ch, undefined);
    continue;
  }
}

/* ============ 盒子绘制 ============ */
function boxTop(b, h) {
  if (b.position.top != null) return b.position.top;
  if (b.position.bottom != null) return h - b.position.bottom - (b.position.height || 1);
  return 0;
}

function drawFrame(grid, top, left, width, height) {
  const H = grid.length;
  const W = grid[0].length;
  const setCell = (r, c, ch, s) => {
    if (r >= 0 && r < H && c >= 0 && c < W) grid[r][c] = { ch, s: s || "" };
  };
  setCell(top, left, "┌", "");
  setCell(top, left + width - 1, "┐", "");
  setCell(top + height - 1, left, "└", "");
  setCell(top + height - 1, left + width - 1, "┘", "");
  for (let c = left + 1; c < left + width - 1; c++) {
    setCell(top, c, "─", "");
    setCell(top + height - 1, c, "─", "");
  }
  for (let r = top + 1; r < top + height - 1; r++) {
    setCell(r, left, "│", "");
    setCell(r, left + width - 1, "│", "");
  }
}

function drawBox(screen, grid, b) {
  const H = screen.height;
  const W = screen.width;
  const top = clampInt(boxTop(b, H), 0, H - 1);
  const left = clampInt(b.position.left ?? 0, 0, W - 1);
  const width = Math.min(b.position.width ?? W - left, W - left);
  if (b.type === "list") {
    drawList(screen, grid, b, top, left, width);
    return;
  }
  const hasBorder = !!b.border;
  const height = clampInt(b.position.height || 1, 1, H - top);
  const bg = b.bg || "";
  const iTop = top + (hasBorder ? 1 : 0);
  const iLeft = left + (hasBorder ? 1 : 0);
  const iW = width - (hasBorder ? 2 : 0);
  const iH = height - (hasBorder ? 2 : 0);
  for (let r = iTop; r < iTop + iH; r++) {
    for (let c = iLeft; c < iLeft + iW; c++) {
      if (r >= 0 && r < H && c >= 0 && c < W) grid[r][c] = { ch: " ", s: bg };
    }
  }
  if (hasBorder) drawFrame(grid, top, left, width, height);
  const cTop = iTop;
  const cLeft = iLeft;
  const lines = String(b._content || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const r = cTop + i;
    if (r < 0 || r >= H) continue;
    writeCells(grid, r, cLeft, tagsToAnsi(lines[i]), W);
  }
}

function drawList(screen, grid, b, top, left, width) {
  const H = screen.height;
  const W = screen.width;
  const height = clampInt(b.position.height || 1, 1, H - top);
  const bg = b.bg || "";
  const setCell = (r, c, ch, s) => {
    if (r >= 0 && r < H && c >= 0 && c < W) grid[r][c] = { ch, s: s || "" };
  };
  const innerH = height - 2;
  for (let r = top + 1; r < top + height - 1; r++) {
    for (let c = left + 1; c < left + width - 1; c++) {
      if (r >= 0 && r < H && c >= 0 && c < W) grid[r][c] = { ch: " ", s: bg };
    }
  }
  setCell(top, left, "┌", "");
  setCell(top, left + width - 1, "┐", "");
  setCell(top + height - 1, left, "└", "");
  setCell(top + height - 1, left + width - 1, "┘", "");
  for (let c = left + 1; c < left + width - 1; c++) {
    setCell(top, c, "─", "");
    setCell(top + height - 1, c, "─", "");
  }
  for (let r = top + 1; r < top + height - 1; r++) {
    setCell(r, left, "│", "");
    setCell(r, left + width - 1, "│", "");
  }
  const start = Math.max(0, b.selected - innerH + 1);
  for (let i = 0; i < innerH; i++) {
    const idx = start + i;
    const r = top + 1 + i;
    const c = left + 1;
    if (idx >= b.items.length) continue;
    const it = String(b.items[idx] || "");
    const sel = idx === b.selected;
    const s = sel ? "\x1b[48;5;6m\x1b[38;5;0m" : bg;
    let x = c;
    const maxChars = width - 2;
    let written = 0;
    for (const ch of it) {
      if (written >= maxChars) break;
      setCell(r, x, ch, s);
      x++;
      written++;
    }
  }
}

/* ============ 整帧绘制 ============ */
function draw(screen) {
  const H = screen.height;
  const W = screen.width;
  if (!H || !W || !process.stdout.isTTY) return;
  if (screen._prevH !== H || screen._prevW !== W) {
    screen._prev = new Array(H).fill(null);
    screen._prevH = H;
    screen._prevW = W;
    process.stdout.write("\x1b[2J\x1b[H");
  }
  const grid = makeGrid(H, W);
  for (const b of screen._boxes) {
    if (b.hidden) continue;
    drawBox(screen, grid, b);
  }
  if (screen._render) screen._render();

  const out = [];
  for (let r = 0; r < H; r++) {
    let line = "\x1b[0m";
    let prevS = "";
    const row = grid[r];
    for (let c = 0; c < W; c++) {
      const cell = row[c];
      if (cell.s !== prevS) {
        line += cell.s || "\x1b[0m";
        prevS = cell.s;
      }
      line += cell.ch;
    }
    if (line !== screen._prev[r]) {
      out.push(`\x1b[${r + 1};1H` + line);
      screen._prev[r] = line;
    }
  }
  const caret = screen._caret || { x: 1, y: H - 1 };
  out.push(`\x1b[${clampInt(caret.y + 1, 1, H)};${clampInt(caret.x + 1, 1, W)}H`);
  out.push(screen._showCaret ? "\x1b[?25h" : "\x1b[?25l");
  process.stdout.write(out.join(""));
}

/* ============ 盒子 / 列表 ============ */
function makeBox(opts, type) {
  const b = {
    type: type || "box",
    _content: "",
    hidden: !!opts.hidden,
    items: [],
    selected: 0,
    position: {
      left: opts.left ?? 0,
      top: opts.top,
      bottom: opts.bottom,
      width: opts.width,
      height: opts.height,
    },
    setContent(s) {
      this._content = s == null ? "" : String(s);
    },
    getContent() {
      return this._content;
    },
    hide() {
      this.hidden = true;
    },
    show() {
      this.hidden = false;
    },
    focus() {},
    clearItems() {
      this.items = [];
      this.selected = 0;
    },
    addItem(s) {
      this.items.push(String(s));
    },
    select(i) {
      this.selected = i | 0;
    },
    on() {},
  };
  if (opts.parent && Array.isArray(opts.parent._boxes)) opts.parent._boxes.push(b);
  return b;
}

/* ============ screen ============ */
function makeScreen() {
  const screen = {
    _boxes: [],
    _keypress: null,
    _render: null,
    _resize: null,
    _pending: "",
    _caret: null,
    _showCaret: false,
    _prev: [],
    _prevH: 0,
    _prevW: 0,
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
    program: {
      cursorPos(x, y) {
        screen._caret = { x, y };
      },
      showCursor() {
        screen._showCaret = true;
      },
      hideCursor() {
        screen._showCaret = false;
      },
    },
    render() {
      draw(screen);
    },
    on(ev, cb) {
      if (ev === "keypress") this._keypress = cb;
      else if (ev === "render") this._render = cb;
      else if (ev === "resize") this._resize = cb;
    },
    destroy() {
      process.stdout.write("\x1b[?25h\x1b[?1049l");
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      } catch {}
      process.exit(0);
    },
  };

    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b[?1002h\x1b[?1006h\x1b[?2004h");
      process.on("exit", () => {
        if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[?1049l");
      });
    process.stdout.on("resize", () => {
      screen.width = process.stdout.columns || screen.width;
      screen.height = process.stdout.rows || screen.height;
      if (screen._resize) screen._resize();
    });
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
        process.stdin.setEncoding("utf8");
        process.stdin.resume();
        process.stdin.on("data", (s) => feed(screen, s));
      } catch {}
    }
  }
  return screen;
}

export default {
  screen: makeScreen,
  box: (opts) => makeBox(opts, "box"),
  list: (opts) => makeBox(opts, "list"),
};

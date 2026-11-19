/*
 * Table Styler: column widths, cell backgrounds and text colours for Markdown tables.
 *
 * Plain CommonJS, no build step. This file is the source.
 *
 * Styles live inside the table cells as Obsidian comments, which reading view hides:
 *
 *   | Name %%{width:160px}%% | Score             |
 *   | ---------------------- | ----------------- |
 *   | Ann %%{bg:yellow}%%    | 12 %%{color:red}%% |
 *
 * - bg / color: a palette name (red, orange, yellow, green, cyan, blue, purple, pink, gray),
 *   which follows the light or dark theme, or any CSS colour such as #e0f2fe.
 * - width: only read from the header cell; it fixes the width of the whole column.
 *
 * Because the token sits in the cell itself, it moves with the cell when rows or
 * columns are moved, sorted or inserted, by Obsidian's own table editor or by hand.
 * (Idea borrowed from Advanced Tables, which keeps its formulas in the note itself.)
 */
'use strict';

const obsidian = require('obsidian');
const { Plugin, Menu, MarkdownView, Notice, PluginSettingTab, Setting, TFile, setIcon } = obsidian;

let cmView = null;
try {
  cmView = require('@codemirror/view');
} catch (e) {
  cmView = null;
}

const LOG = '[table-styler]';

/* ------------------------------------------------------------------ */
/* Style tokens                                                        */
/* ------------------------------------------------------------------ */

// %%{ ... }%% where the body has no braces, pipes, newlines or "%%" (a single % is fine: width:40%).
const TOKEN_RE = /[ \t]*%%\{((?:[^{}%|\n]|%(?!%))*)\}%%/g;

const PALETTE = [
  ['red', 'Red'],
  ['orange', 'Orange'],
  ['yellow', 'Yellow'],
  ['green', 'Green'],
  ['cyan', 'Cyan'],
  ['blue', 'Blue'],
  ['purple', 'Purple'],
  ['pink', 'Pink'],
  ['gray', 'Gray'],
];
const NAMED = new Set(PALETTE.map((p) => p[0]));

const KEY_ALIASES = {
  bg: 'bg',
  background: 'bg',
  'background-color': 'bg',
  color: 'color',
  text: 'color',
  fg: 'color',
  width: 'width',
  w: 'width',
};
const KEY_ORDER = ['bg', 'color', 'width'];

function parseDecls(body) {
  const out = {};
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const key = KEY_ALIASES[part.slice(0, i).trim().toLowerCase()];
    const value = part.slice(i + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/** Style object of one cell's text; later tokens win. */
function readCell(text) {
  const style = {};
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) Object.assign(style, parseDecls(m[1]));
  return style;
}

function stripTokens(text) {
  return text.replace(TOKEN_RE, '').trim();
}

function formatToken(style) {
  const parts = [];
  for (const k of KEY_ORDER) if (style[k]) parts.push(k + ':' + style[k]);
  return parts.length ? '%%{' + parts.join('; ') + '}%%' : '';
}

/** New cell text: the visible text, then one token at the end (or none). */
function writeCell(text, style) {
  const clean = stripTokens(text);
  const token = formatToken(style);
  if (!token) return clean;
  return clean ? clean + ' ' + token : token;
}

/* Values come from note text and end up in a <style> element, so they are whitelisted. */

function isSafeColor(v) {
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return true;
  if (/^(?:rgba?|hsla?)\([0-9.,%\s/+-]{1,60}\)$/i.test(v)) return true;
  if (/^[a-z]{3,24}$/i.test(v)) {
    try {
      return typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('color', v);
    } catch (e) {
      return false;
    }
  }
  return false;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function bgValue(v, strength) {
  const name = String(v).toLowerCase();
  if (NAMED.has(name)) {
    if (name === 'gray') return 'rgba(var(--mono-rgb-100), ' + round2(strength * 0.55) + ')';
    return 'rgba(var(--color-' + name + '-rgb), ' + round2(strength) + ')';
  }
  return isSafeColor(v) ? v : null;
}

function fgValue(v) {
  const name = String(v).toLowerCase();
  if (NAMED.has(name)) return name === 'gray' ? 'var(--text-muted)' : 'var(--color-' + name + ')';
  return isSafeColor(v) ? v : null;
}

function colourLabel(v) {
  const named = PALETTE.find((p) => p[0] === v);
  if (named) return named[1];
  const s = String(v);
  return /^[a-z]+$/i.test(s) ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s.toUpperCase();
}

/** Perceived brightness 0..255 (YIQ), or null when unknown. */
function brightnessOf(v, resolve) {
  if (NAMED.has(String(v).toLowerCase())) return null;
  const rgb = colorToRgb(v) || (resolve ? resolve(v) : null);
  return rgb ? (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 : null;
}

/** { r, g, b, a } for hex and rgb()/rgba() strings, else null. */
function colorToRgb(v) {
  const s = String(v).trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(s);
  if (m) {
    let a = m[4] === undefined ? 1 : Number(m[4]);
    if (m[5] === '%') a /= 100;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  return null;
}

/**
 * Readable text colour for a custom background: white on dark fills, near-black on light
 * ones (which also keeps light fills readable in a dark theme). Palette names are soft
 * tints that follow the theme, so they keep the theme's text colour. `resolve` turns CSS
 * keywords or hsl() into rgb when a DOM is available.
 */
function autoTextColor(bg, resolve) {
  if (NAMED.has(String(bg).toLowerCase()) || !isSafeColor(bg)) return null;
  const rgb = colorToRgb(bg) || (resolve ? resolve(bg) : null);
  if (!rgb || rgb.a < 0.6) return null;
  const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000; // YIQ, 0..255
  return brightness < 140 ? '#ffffff' : '#1f1f1f';
}

function widthValue(v) {
  const m = /^(\d{1,4}(?:\.\d{1,2})?)\s*(px|em|rem|ch|%)?$/i.exec(String(v).trim());
  if (!m || Number(m[1]) <= 0) return null;
  return m[1] + (m[2] ? m[2].toLowerCase() : 'px');
}

/* ------------------------------------------------------------------ */
/* Markdown table parsing                                              */
/* A "src" is { count, get(i) } over 0-based lines.                    */
/* ------------------------------------------------------------------ */

/** Leading indentation and blockquote / callout markers ("> "). */
function prefixLength(line) {
  return /^(?:[ \t]*>)*[ \t]*/.exec(line)[0].length;
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

/**
 * Cells of one table row, split on unescaped pipes (GFM rules).
 * Each cell: { from, to } between the pipes, { cs, ce } the trimmed content.
 */
function cellRanges(line) {
  const a = prefixLength(line);
  let b = line.length;
  while (b > a && isSpace(line[b - 1])) b--;
  if (a >= b) return null;
  const pipes = [];
  for (let i = a; i < b; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '|') pipes.push(i);
  }
  if (!pipes.length) return null;
  const bounds = pipes.slice();
  if (bounds[0] !== a) bounds.unshift(a - 1);
  if (bounds[bounds.length - 1] !== b - 1) bounds.push(b);
  const cells = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const from = bounds[k] + 1;
    const to = bounds[k + 1];
    let cs = from;
    let ce = to;
    while (cs < ce && isSpace(line[cs])) cs++;
    while (ce > cs && isSpace(line[ce - 1])) ce--;
    if (cs === ce) cs = ce = Math.min(from + 1, to);
    cells.push({ from, to, cs, ce });
  }
  return cells.length ? cells : null;
}

function isDelimiterRow(line) {
  const cells = cellRanges(line);
  if (!cells) return null;
  for (const c of cells) {
    if (!/^:?-+:?$/.test(line.slice(c.cs, c.ce))) return null;
  }
  return cells;
}

/** Table whose header row is line `start`, or null. rows[0] is the header. */
function parseTableAt(src, start) {
  if (start < 0 || start + 1 >= src.count) return null;
  const headText = src.get(start);
  const head = cellRanges(headText);
  if (!head) return null;
  const delim = isDelimiterRow(src.get(start + 1));
  if (!delim) return null;
  const rows = [{ line: start, text: headText, cells: head }];
  for (let i = start + 2; i < src.count; i++) {
    const text = src.get(i);
    if (text.slice(prefixLength(text)).trim() === '') break;
    const cells = cellRanges(text);
    if (!cells) break;
    rows.push({ line: i, text, cells });
  }
  for (const row of rows) row.styles = row.cells.map((c) => readCell(row.text.slice(c.cs, c.ce)));
  return { start, delimLine: start + 1, end: rows[rows.length - 1].line, columns: delim.length, rows };
}

/** All tables that start inside [from, to], in order. */
function findTablesInRange(src, from, to) {
  const out = [];
  for (let s = Math.max(0, from); s <= Math.min(to, src.count - 1); s++) {
    const t = parseTableAt(src, s);
    if (t) {
      out.push(t);
      s = t.end;
    }
  }
  return out;
}

/** The table that contains `line`, or null. */
function findTableAround(src, line) {
  if (line < 0 || line >= src.count || !cellRanges(src.get(line))) return null;
  let top = line;
  while (top > 0 && cellRanges(src.get(top - 1))) top--;
  for (let s = top; s <= line; s++) {
    const t = parseTableAt(src, s);
    if (!t) continue;
    if (t.end >= line) return t;
    s = t.end;
  }
  return null;
}

/** One cell edit as { line, from, to, insert }, or null when nothing changes. */
function cellEdit(table, r, c, mutate) {
  const row = table.rows[r];
  if (!row) return null;
  const cell = row.cells[c];
  if (!cell) return null;
  const oldText = row.text.slice(cell.cs, cell.ce);
  const style = Object.assign({}, readCell(oldText));
  mutate(style);
  for (const k of Object.keys(style)) if (!style[k]) delete style[k];
  const insert = writeCell(oldText, style);
  if (insert === oldText) return null;
  return { line: row.line, from: cell.cs, to: cell.ce, insert };
}

/** Apply edits to a whole text (used for files that are not open in an editor). */
function applyLineChanges(text, changes) {
  const lines = text.split('\n');
  const sorted = changes.slice().sort((x, y) => (x.line - y.line) || (y.from - x.from));
  for (const ch of sorted) {
    const l = lines[ch.line];
    if (l === undefined) continue;
    lines[ch.line] = l.slice(0, ch.from) + ch.insert + l.slice(ch.to);
  }
  return lines.join('\n');
}

/** Rectangle of cells between two cursor positions. */
function targetsBetween(table, from, to) {
  const rowOf = (pos) => {
    if (pos.line <= table.start) return 0;
    if (pos.line > table.end) return table.rows.length - 1;
    if (pos.line === table.delimLine) return 0;
    const i = table.rows.findIndex((r) => r.line === pos.line);
    return i < 0 ? 0 : i;
  };
  const colOf = (r, pos) => {
    const cells = table.rows[r].cells;
    if (pos.line !== table.rows[r].line) return pos.line < table.rows[r].line ? 0 : cells.length - 1;
    for (let c = 0; c < cells.length; c++) if (pos.ch <= cells[c].to) return c;
    return cells.length - 1;
  };
  const r1 = rowOf(from);
  const r2 = rowOf(to);
  const c1 = colOf(r1, from);
  const c2 = colOf(r2, to);
  const out = [];
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) out.push({ r, c });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* CSS for one rendered table                                          */
/* ------------------------------------------------------------------ */

function indexIn(el) {
  return Array.prototype.indexOf.call(el.parentElement.children, el);
}

/**
 * Rules scoped to one <table data-tcs-id>. Selectors follow the real DOM
 * (thead/tbody or not), and use nth-child so they survive cells being re-rendered.
 */
function buildCss(tableEl, table, opts) {
  const scope = 'table[data-tcs-id="' + tableEl.dataset.tcsId + '"]';
  const rules = [];

  const widths = {};
  table.rows[0].styles.forEach((st, c) => {
    if (!st.width) return;
    const w = widthValue(st.width);
    if (w) widths[c] = w;
  });
  if (opts.drag && opts.drag.table === tableEl) widths[opts.drag.col] = opts.drag.width + 'px';
  for (const c of Object.keys(widths)) {
    const w = widths[c];
    rules.push(
      scope + ' tr > :nth-child(' + (Number(c) + 1) + '){width:' + w + '!important;min-width:' + w +
        '!important;max-width:' + w + '!important;box-sizing:border-box;overflow-wrap:anywhere;}'
    );
  }

  const domRows = tableEl.rows;
  table.rows.forEach((row, r) => {
    const tr = domRows[r];
    if (!tr || !tr.parentElement) return;
    const parent = tr.parentElement;
    const rowSel =
      parent === tableEl
        ? scope + ' > tr:nth-child(' + (indexIn(tr) + 1) + ')'
        : scope + ' > ' + parent.tagName.toLowerCase() + ' > tr:nth-child(' + (indexIn(tr) + 1) + ')';
    row.styles.forEach((st, c) => {
      const decl = [];
      if (st.bg) {
        const v = bgValue(st.bg, opts.strength);
        if (v) decl.push('background-color:' + v + '!important');
      }
      if (st.color) {
        const v = fgValue(st.color);
        if (v) decl.push('color:' + v + '!important');
      } else if (st.bg && opts.autoText) {
        const v = autoTextColor(st.bg, opts.resolve);
        if (v) decl.push('color:' + v + '!important');
      }
      if (decl.length) rules.push(rowSel + ' > :nth-child(' + (c + 1) + '){' + decl.join(';') + '}');
    });
  });
  return rules.join('\n');
}

/* ------------------------------------------------------------------ */
/* Editing back-ends: CodeMirror view, Obsidian editor, or the file   */
/* Each ref: { startLine, async load() -> src, async apply(changes) }  */
/* ------------------------------------------------------------------ */

function cmRef(view, startLine) {
  return {
    startLine,
    async load() {
      const doc = view.state.doc;
      return { count: doc.lines, get: (i) => doc.line(i + 1).text };
    },
    async apply(changes) {
      const doc = view.state.doc;
      view.dispatch({
        changes: changes.map((ch) => {
          const l = doc.line(ch.line + 1);
          return { from: l.from + ch.from, to: l.from + ch.to, insert: ch.insert };
        }),
        userEvent: 'input.table-styler',
      });
    },
  };
}

function editorRef(editor, startLine) {
  return {
    startLine,
    async load() {
      return { count: editor.lineCount(), get: (i) => editor.getLine(i) };
    },
    async apply(changes) {
      editor.transaction({
        changes: changes.map((ch) => ({
          from: { line: ch.line, ch: ch.from },
          to: { line: ch.line, ch: ch.to },
          text: ch.insert,
        })),
      });
    },
  };
}

/** onApplied(newText) runs after each write, with the note's new content. */
function fileRef(app, path, startLine, onApplied) {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  return {
    startLine,
    async load() {
      // Flush any pending edits of this note before reading it from disk.
      for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        const v = leaf.view;
        if (v && v.file && v.file.path === path && typeof v.save === 'function') {
          try {
            await v.save();
          } catch (e) {
            /* ignore */
          }
        }
      }
      const lines = (await app.vault.read(file)).split('\n');
      return { count: lines.length, get: (i) => lines[i] };
    },
    async apply(changes) {
      const text = await app.vault.process(file, (data) => applyLineChanges(data, changes));
      if (onApplied && typeof text === 'string') onApplied(text);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Popover                                                             */
/* ------------------------------------------------------------------ */

class StylePopover {
  /**
   * opts: { doc, x, y, ref, targets: [{r,c}], tableEl (null in source mode) }
   */
  constructor(plugin, opts) {
    this.plugin = plugin;
    this.doc = opts.doc || activeDocument;
    this.x = opts.x;
    this.y = opts.y;
    this.ref = opts.ref;
    this.targets = opts.targets;
    this.tableEl = opts.tableEl || null;
    this.scopeEl = this.tableEl ? this.tableEl.closest('.view-content') || this.doc.body : null;
    this.colours = opts.colours !== false; // false in Reading view: widths only
    this.segButtons = {};
    this.bgRow = null;
    this.fgRow = null;
    this.blocks = {};
    this.editing = false;
    this.editBtn = null;
    this.scope = 'cells';
    this.table = null;
    this.busy = Promise.resolve();
    this.onDocPointer = this.onDocPointer.bind(this);
    this.onKey = this.onKey.bind(this);
  }

  async open() {
    this.table = await this.loadTable();
    if (!this.table) {
      new Notice('Table Styler: could not find this table in the note.');
      return;
    }
    if (this.plugin.popover) this.plugin.popover.close();
    this.plugin.popover = this;

    const el = (this.el = this.doc.body.createDiv({ cls: 'tcs-popover' }));
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('contextmenu', (e) => e.stopPropagation());

    const head = el.createDiv({ cls: 'tcs-head' });
    const title = head.createDiv({ cls: 'tcs-title' });
    title.createSpan({ text: this.colours ? 'Cell style' : 'Column width' });
    this.countEl = title.createSpan({ cls: 'tcs-count' });
    const buttons = head.createDiv({ cls: 'tcs-head-buttons' });
    if (this.colours) {
      const edit = (this.editBtn = buttons.createDiv({
        cls: 'tcs-edit clickable-icon',
        attr: { 'aria-label': 'Edit colour lists' },
      }));
      setIcon(edit, 'pencil');
      edit.addEventListener('click', () => this.toggleEditing());
    }
    const close = buttons.createDiv({ cls: 'tcs-close clickable-icon', attr: { 'aria-label': 'Close' } });
    setIcon(close, 'x');
    close.addEventListener('click', () => this.close());

    if (this.colours) {
      el.createDiv({ cls: 'tcs-label', text: 'Apply to' });
      const seg = el.createDiv({ cls: 'tcs-seg' });
      for (const [key, label] of [
        ['cells', this.targets.length > 1 ? 'Selection' : 'Cell'],
        ['row', 'Row'],
        ['column', 'Column'],
      ]) {
        const b = seg.createEl('button', { text: label });
        b.addEventListener('click', () => {
          this.scope = key;
          this.refresh();
        });
        this.segButtons[key] = b;
      }

      el.createDiv({ cls: 'tcs-label', text: 'Background' });
      this.bgRow = el.createDiv({ cls: 'tcs-colour-block' });
      el.createDiv({ cls: 'tcs-label', text: 'Text colour' });
      this.fgRow = el.createDiv({ cls: 'tcs-colour-block' });

      const hint = el.createDiv({ cls: 'tcs-edit-hint' });
      hint.createDiv({ text: 'Click × to remove a colour, + to add a recent or custom one.' });
      const links = hint.createDiv({ cls: 'tcs-edit-links' });
      const reset = links.createSpan({ cls: 'tcs-link', text: 'Reset to default colours' });
      const clearRecent = links.createSpan({ cls: 'tcs-link', text: 'Clear recent' });
      reset.addEventListener('click', async () => {
        await this.plugin.resetPalettes();
        this.buildSwatches();
        this.refresh();
      });
      clearRecent.addEventListener('click', async () => {
        await this.plugin.clearRecent();
        this.buildSwatches();
        this.refresh();
      });

      this.buildSwatches();
    }

    el.createDiv({ cls: 'tcs-label', text: this.colours ? 'Column width' : 'This column' });
    const wrow = el.createDiv({ cls: 'tcs-width-row' });
    this.widthInput = wrow.createEl('input', {
      type: 'number',
      attr: { min: '20', max: '2000', step: '10', placeholder: 'auto' },
    });
    wrow.createSpan({ cls: 'tcs-unit', text: 'px' });
    const setW = wrow.createEl('button', { text: 'Fix' });
    const autoW = wrow.createEl('button', { text: 'Auto' });
    setW.addEventListener('click', () => this.applyWidthFromInput());
    autoW.addEventListener('click', () => this.queue(() => this.applyWidth(null)));
    this.widthInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.applyWidthFromInput();
      }
    });

    const actions = el.createDiv({ cls: 'tcs-actions' });
    if (this.tableEl) {
      const lock = actions.createEl('button', { text: 'Fix all columns as shown' });
      lock.setAttribute('aria-label', 'Write the current width of every column into the table');
      lock.addEventListener('click', () => this.queue(() => this.lockAllWidths()));
    }
    const resetAll = actions.createEl('button', { text: 'All widths auto' });
    resetAll.addEventListener('click', () => this.queue(() => this.resetAllWidths()));
    if (this.colours) {
      const clear = actions.createEl('button', { text: 'Clear colours', cls: 'mod-warning' });
      clear.addEventListener('click', () =>
        this.queue(() =>
          this.applyStyle((st) => {
            delete st.bg;
            delete st.color;
          })
        )
      );
    }

    this.position();
    this.refresh();
    this.doc.addEventListener('pointerdown', this.onDocPointer, true);
    this.doc.addEventListener('keydown', this.onKey, true);
  }

  /* ---------- colour rows: Common (editable) + Recent (last 5 used) ---------- */

  toggleEditing() {
    this.editing = !this.editing;
    this.el.toggleClass('is-editing', this.editing);
    setIcon(this.editBtn, this.editing ? 'check' : 'pencil');
    this.editBtn.setAttribute('aria-label', this.editing ? 'Done editing colours' : 'Edit colour lists');
    this.buildSwatches();
    this.refresh();
  }

  buildSwatches() {
    this.blocks = {};
    for (const [kind, block] of [
      ['bg', this.bgRow],
      ['color', this.fgRow],
    ]) {
      block.empty();
      const main = block.createDiv({ cls: 'tcs-swatches' });
      const recent = block.createDiv({ cls: 'tcs-recent-holder' });
      this.blocks[kind] = { main, recent };
      this.makeCustom(main, kind);
      this.fillMain(kind);
      this.renderRecent(kind);
    }
  }

  /** "None" + the common colours, placed before the custom picker (which is kept alive). */
  fillMain(kind) {
    const { main } = this.blocks[kind];
    const picker = main.querySelector('.tcs-swatch-custom');
    for (const child of Array.from(main.children)) if (child !== picker) child.remove();
    const add = (value, label, badge) => main.insertBefore(this.makeSwatch(main, kind, value, label, badge), picker);
    if (!this.editing) add('', kind === 'bg' ? 'No fill' : 'Automatic', null);
    for (const v of this.plugin.palette(kind)) add(v, colourLabel(v), this.editing ? 'remove' : null);
  }

  renderRecent(kind) {
    const { recent } = this.blocks[kind];
    recent.empty();
    const common = this.plugin.palette(kind);
    let list = this.plugin.recent(kind);
    if (this.editing) list = list.filter((v) => !common.includes(v));
    if (!list.length) return;
    // Same 6-column grid as the row above: the label takes the first column.
    const row = recent.createDiv({ cls: 'tcs-swatches tcs-recent' });
    row.createSpan({ cls: 'tcs-recent-label', text: 'Recent' });
    for (const v of list) this.makeSwatch(row, kind, v, colourLabel(v), this.editing ? 'add' : null);
  }

  makeSwatch(row, kind, value, label, badge) {
    const s = row.createDiv({ cls: 'tcs-swatch', attr: { 'aria-label': label } });
    s.dataset.value = value;
    const brightness = value ? brightnessOf(value, (v) => this.plugin.resolveColour(v)) : null;
    if (!value) {
      s.addClass('tcs-swatch-none');
    } else if (kind === 'bg') {
      s.style.backgroundColor = bgValue(value, this.plugin.settings.strength) || 'transparent';
      // A very light fill still needs a visible rim.
      s.style.borderColor =
        brightness !== null && brightness > 230 ? 'var(--background-modifier-border)' : fgValue(value) || 'var(--background-modifier-border)';
    } else {
      s.addClass('tcs-swatch-text');
      s.setText('A');
      s.style.color = fgValue(value) || '';
      // White or very light text is shown on a dark chip so it can be seen.
      if (brightness !== null && brightness > 200) s.addClass('tcs-swatch-on-dark');
    }
    if (badge) {
      s.addClass('is-' + badge);
      s.createSpan({ cls: 'tcs-badge', text: badge === 'remove' ? '×' : '+' });
      s.setAttribute('aria-label', (badge === 'remove' ? 'Remove ' : 'Add ') + label);
    }
    s.addEventListener('click', async () => {
      if (badge) {
        await this.plugin.editPalette(kind, badge, value);
        this.fillMain(kind);
        this.renderRecent(kind);
        this.refresh();
        return;
      }
      this.pick(kind, value);
    });
    return s;
  }

  pick(kind, value, replaces) {
    if (value) {
      this.plugin.rememberUse(kind, value, replaces);
      this.renderRecent(kind);
    }
    this.queue(() =>
      this.applyStyle((st) => {
        if (value) st[kind] = value;
        else delete st[kind];
      })
    );
  }

  /**
   * The rainbow swatch opens the system colour picker. While a picker session is open,
   * later values replace the earlier one (no trail of in-between colours in Recent).
   * In edit mode it adds the colour to the common list instead of applying it.
   */
  makeCustom(row, kind) {
    const editing = !!this.editing;
    const wrap = row.createEl('label', {
      cls: 'tcs-swatch tcs-swatch-custom',
      attr: { 'aria-label': editing ? 'Add a custom colour' : 'Custom colour' },
    });
    if (editing) {
      wrap.addClass('is-add');
      wrap.createSpan({ cls: 'tcs-badge', text: '+' });
    }
    const input = wrap.createEl('input', { type: 'color' });
    const current = this.commonValue(kind);
    input.value = current && /^#[0-9a-f]{6}$/i.test(current) ? current : '#ffd966';
    let timer = 0;
    let session = null;
    input.addEventListener('click', () => {
      session = null;
    });
    const commit = async () => {
      const v = input.value.toLowerCase();
      if (v === session) return;
      const previous = session;
      session = v;
      if (editing) {
        await this.plugin.editPalette(kind, 'add', v, previous);
        this.fillMain(kind);
        this.renderRecent(kind);
        this.refresh();
      } else {
        this.pick(kind, v, previous);
      }
    };
    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(commit, 600);
    });
    input.addEventListener('change', () => {
      window.clearTimeout(timer);
      commit();
    });
  }

  position() {
    const el = this.el;
    const win = this.doc.defaultView || window;
    const pad = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = this.x;
    let y = this.y + 6;
    if (x + w + pad > win.innerWidth) x = win.innerWidth - w - pad;
    if (y + h + pad > win.innerHeight) y = Math.max(pad, this.y - h - 6);
    el.style.left = Math.max(pad, x) + 'px';
    el.style.top = Math.max(pad, y) + 'px';
  }

  onDocPointer(e) {
    if (this.el && !this.el.contains(e.target)) this.close();
  }

  onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  close() {
    this.doc.removeEventListener('pointerdown', this.onDocPointer, true);
    this.doc.removeEventListener('keydown', this.onKey, true);
    if (this.el) this.el.remove();
    this.el = null;
    if (this.plugin.popover === this) this.plugin.popover = null;
  }

  /** Run edits one after another so fast clicks never overlap. */
  queue(fn) {
    this.busy = this.busy.then(fn).catch((e) => {
      console.error(LOG, e);
      new Notice('Table Styler: ' + (e && e.message ? e.message : 'edit failed'));
    });
    return this.busy;
  }

  async loadTable() {
    const src = await this.ref.load();
    return parseTableAt(src, this.ref.startLine);
  }

  /** Cells the current "Apply to" choice covers. */
  expanded(table) {
    const out = [];
    const seen = new Set();
    const add = (r, c) => {
      const k = r + ':' + c;
      if (seen.has(k) || !table.rows[r] || !table.rows[r].cells[c]) return;
      seen.add(k);
      out.push({ r, c });
    };
    if (this.scope === 'row') {
      for (const r of new Set(this.targets.map((t) => t.r))) {
        for (let c = 0; c < table.rows[r].cells.length; c++) add(r, c);
      }
    } else if (this.scope === 'column') {
      for (const c of new Set(this.targets.map((t) => t.c))) {
        for (let r = 0; r < table.rows.length; r++) add(r, c);
      }
    } else {
      for (const t of this.targets) add(t.r, t.c);
    }
    return out;
  }

  columns() {
    return Array.from(new Set(this.targets.map((t) => t.c)));
  }

  async edit(collect) {
    const table = await this.loadTable();
    if (!table) throw new Error('could not find this table any more');
    const changes = collect(table).filter(Boolean);
    if (changes.length) await this.ref.apply(changes);
    this.table = (await this.loadTable()) || table;
    this.refresh();
  }

  applyStyle(mutate) {
    return this.edit((table) => this.expanded(table).map((t) => cellEdit(table, t.r, t.c, mutate)));
  }

  applyWidth(width) {
    return this.edit((table) =>
      this.columns().map((c) =>
        cellEdit(table, 0, c, (st) => {
          if (width) st.width = width;
          else delete st.width;
        })
      )
    );
  }

  applyWidthFromInput() {
    const raw = this.widthInput.value.trim();
    if (!raw) return this.queue(() => this.applyWidth(null));
    const w = widthValue(raw);
    if (!w) {
      new Notice('Table Styler: width must be a number, e.g. 160');
      return;
    }
    return this.queue(() => this.applyWidth(w));
  }

  lockAllWidths() {
    const tableEl = this.plugin.findRendered(this.tableEl, this.ref.startLine, this.scopeEl);
    const head = tableEl && tableEl.rows[0];
    if (!head) {
      new Notice('Table Styler: the table is not visible right now.');
      return;
    }
    const widths = Array.from(head.cells).map((cell) => Math.round(cell.getBoundingClientRect().width));
    return this.edit((table) =>
      widths.map((w, c) => (w > 0 ? cellEdit(table, 0, c, (st) => (st.width = w + 'px')) : null))
    );
  }

  resetAllWidths() {
    return this.edit((table) => table.rows[0].cells.map((_, c) => cellEdit(table, 0, c, (st) => delete st.width)));
  }

  /** Shared value of a key across the covered cells, or null when they differ. */
  commonValue(kind) {
    const table = this.table;
    if (!table) return null;
    const cells = this.expanded(table);
    let value;
    for (const t of cells) {
      const v = (table.rows[t.r].styles[t.c] || {})[kind] || '';
      if (value === undefined) value = v;
      else if (value !== v) return null;
    }
    return value === undefined ? null : value;
  }

  refresh() {
    if (!this.el || !this.table) return;
    const cells = this.expanded(this.table);
    this.countEl.setText(!this.colours || cells.length === 1 ? '' : cells.length + ' cells');
    for (const key of Object.keys(this.segButtons)) this.segButtons[key].toggleClass('is-active', key === this.scope);
    const mark = (row, kind) => {
      if (!row) return;
      const v = this.commonValue(kind);
      row.querySelectorAll('.tcs-swatch').forEach((s) => {
        s.toggleClass('is-active', v !== null && s.dataset.value !== undefined && s.dataset.value === v);
      });
    };
    mark(this.bgRow, 'bg');
    mark(this.fgRow, 'color');
    const cols = this.columns();
    const widths = new Set(cols.map((c) => (this.table.rows[0].styles[c] || {}).width || ''));
    const doc = this.doc;
    if (doc.activeElement !== this.widthInput) {
      const only = widths.size === 1 ? Array.from(widths)[0] : '';
      const m = /^(\d+(?:\.\d+)?)px$/.exec(only);
      this.widthInput.value = m ? m[1] : '';
    }
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

// With "none" first and the custom picker last, each list fills two rows of six.
const OLD_DEFAULT_COMMON = PALETTE.map((p) => p[0]);
const DEFAULT_COMMON_BG = OLD_DEFAULT_COMMON.concat(['black']);
const DEFAULT_COMMON_TEXT = OLD_DEFAULT_COMMON.concat(['white']);
const PALETTE_VERSION = 2;
const RECENT_MAX = 5;

const DEFAULT_SETTINGS = {
  strength: 0.22,
  autoText: true,
  commonBg: null, // filled with the defaults on first load
  commonText: null,
  recentBg: [],
  recentText: [],
};

function isColourValue(v) {
  return typeof v === 'string' && (NAMED.has(v) || isSafeColor(v));
}

/** Fill defaults, drop invalid entries, and migrate the 0.1 "recent" list. */
function normalizeSettings(s) {
  const clean = (list, fallback) => (Array.isArray(list) ? Array.from(new Set(list.filter(isColourValue))) : fallback.slice());
  if (Array.isArray(s.recent)) {
    if (!Array.isArray(s.recentBg)) s.recentBg = s.recent.slice();
    if (!Array.isArray(s.recentText)) s.recentText = s.recent.slice();
  }
  delete s.recent;
  s.commonBg = clean(s.commonBg, DEFAULT_COMMON_BG);
  s.commonText = clean(s.commonText, DEFAULT_COMMON_TEXT);
  // Once: lists still equal to the 0.1 defaults gain black (background) and white (text).
  if (s.paletteVersion !== PALETTE_VERSION) {
    const isOld = (list) => list.length === OLD_DEFAULT_COMMON.length && list.every((v, i) => v === OLD_DEFAULT_COMMON[i]);
    if (isOld(s.commonBg)) s.commonBg = DEFAULT_COMMON_BG.slice();
    if (isOld(s.commonText)) s.commonText = DEFAULT_COMMON_TEXT.slice();
    s.paletteVersion = PALETTE_VERSION;
  }
  s.recentBg = clean(s.recentBg, []).slice(0, RECENT_MAX);
  s.recentText = clean(s.recentText, []).slice(0, RECENT_MAX);
  if (typeof s.autoText !== 'boolean') s.autoText = true;
  if (typeof s.strength !== 'number') s.strength = 0.22;
  return s;
}

class TableStylerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Background strength')
      .setDesc('How strong the palette backgrounds are. Custom colours are used exactly as picked.')
      .addSlider((s) =>
        s
          .setLimits(10, 60, 2)
          .setValue(Math.round(this.plugin.settings.strength * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.strength = v / 100;
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          })
      );

    new Setting(containerEl)
      .setName('Automatic text colour')
      .setDesc(
        'On custom background colours, use white text on dark fills and dark text on light fills, ' +
          'unless the cell has its own text colour.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoText).onChange(async (v) => {
          this.plugin.settings.autoText = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName('Colour lists')
      .setDesc(
        'Edit the common colours with the pencil button in the Cell style panel. ' +
          'Reset restores the default colours and clears the recent ones.'
      )
      .addButton((b) =>
        b.setButtonText('Reset').onClick(async () => {
          await this.plugin.resetPalettes();
          await this.plugin.clearRecent();
          new Notice('Table Styler: colour lists reset.');
        })
      );

    const help = containerEl.createDiv({ cls: 'tcs-help' });
    help.createEl('p', {
      text:
        'In Live Preview or Source mode, right-click a table cell and choose "Cell style…" for colours and ' +
        'widths. Reading view shows the colours but only lets you change column widths. Drag the right edge ' +
        'of a column to fix its width; double-click the edge to make it automatic again.',
    });
    help.createEl('p', { text: 'Styles are saved in the cell as a hidden comment, for example:' });
    help.createEl('pre', {
      text: '| Name %%{width:160px}%% | Score |\n| --- | --- |\n| Ann %%{bg:yellow; color:red}%% | 12 |',
    });
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

const EDGE_PX = 5;
const MIN_COL_PX = 36;

class TableStylerPlugin extends Plugin {
  async onload() {
    this.settings = normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, await this.loadData()));
    this.colourCache = new Map();

    this.nextId = 1;
    this.entries = new WeakMap(); // tableEl -> { table, kind, host, styleEl }
    this.liveTables = new Set(); // live preview tables, pruned when they leave the DOM
    this.wired = new WeakSet();
    this.drag = null;
    this.popover = null;
    this.refreshTimers = [];

    this.addSettingTab(new TableStylerSettingTab(this.app, this));

    // Reading view (and embeds that come with section info).
    this.registerMarkdownPostProcessor((el, ctx) => this.processReading(el, ctx));
    // Reading view reuses sections whose visible text is unchanged, so re-sync on
    // mode switches and file changes (e.g. colours changed in Live Preview).
    this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleReadingRefresh()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleReadingRefresh()));
    this.registerEvent(this.app.vault.on('modify', () => this.scheduleReadingRefresh()));

    // Live preview: Obsidian draws tables as a CodeMirror widget.
    if (cmView) this.registerEditorExtension(this.liveExtension());
    else console.warn(LOG, '@codemirror/view not available; live preview styling is off');

    this.installMenuPatch();
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => this.onEditorMenu(menu, editor, info)));
    this.registerDomEvent(document, 'contextmenu', (e) => this.onContextMenuFallback(e));
    this.registerEvent(
      this.app.workspace.on('window-open', (_ws, win) => {
        this.registerDomEvent(win.document, 'contextmenu', (e) => this.onContextMenuFallback(e));
      })
    );

    this.addCommand({
      id: 'style-cells',
      name: 'Style table cell(s) at cursor',
      icon: 'palette',
      editorCheckCallback: (checking, editor) => {
        const found = this.tableAtCursor(editor);
        if (!found) return false;
        if (!checking) this.openFromEditor(editor, found);
        return true;
      },
    });

    this.addCommand({
      id: 'clear-table',
      name: 'Clear all styles in table at cursor',
      icon: 'eraser',
      editorCheckCallback: (checking, editor) => {
        const found = this.tableAtCursor(editor);
        if (!found) return false;
        if (!checking) {
          const { table } = found;
          const changes = [];
          table.rows.forEach((row, r) =>
            row.cells.forEach((_, c) =>
              changes.push(
                cellEdit(table, r, c, (st) => {
                  delete st.bg;
                  delete st.color;
                  delete st.width;
                })
              )
            )
          );
          const real = changes.filter(Boolean);
          if (real.length) editorRef(editor, table.start).apply(real);
          new Notice(real.length ? 'Table Styler: cleared ' + real.length + ' cell(s).' : 'Table Styler: nothing to clear.');
        }
        return true;
      },
    });
  }

  onunload() {
    if (this.popover) this.popover.close();
    for (const t of this.refreshTimers) window.clearTimeout(t);
    for (const d of this.openDocuments()) {
      d.querySelectorAll('style[data-tcs-for]').forEach((s) => s.remove());
      d.querySelectorAll('.tcs-col-edge').forEach((t) => t.removeClass('tcs-col-edge'));
      d.querySelectorAll('table[data-tcs-id]').forEach((t) => t.removeAttribute('data-tcs-id'));
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ---------- colour lists ---------- */

  palette(kind) {
    return kind === 'bg' ? this.settings.commonBg : this.settings.commonText;
  }

  recent(kind) {
    return kind === 'bg' ? this.settings.recentBg : this.settings.recentText;
  }

  /** op: 'add' | 'remove'. With `replaces`, an add swaps that colour out in place. */
  async editPalette(kind, op, value, replaces) {
    const key = kind === 'bg' ? 'commonBg' : 'commonText';
    let list = this.settings[key].slice();
    if (op === 'remove') {
      list = list.filter((v) => v !== value);
    } else if (isColourValue(value)) {
      if (replaces && list.includes(replaces)) list = list.map((v) => (v === replaces ? value : v));
      else list.push(value);
    }
    this.settings[key] = Array.from(new Set(list));
    await this.saveSettings();
  }

  /** Most recent first, at most RECENT_MAX. `replaces` drops an in-between picker value. */
  rememberUse(kind, value, replaces) {
    if (!isColourValue(value)) return;
    const key = kind === 'bg' ? 'recentBg' : 'recentText';
    const list = this.settings[key].filter((v) => v !== value && v !== replaces);
    list.unshift(value);
    this.settings[key] = list.slice(0, RECENT_MAX);
    this.saveSettings();
  }

  async resetPalettes() {
    this.settings.commonBg = DEFAULT_COMMON_BG.slice();
    this.settings.commonText = DEFAULT_COMMON_TEXT.slice();
    await this.saveSettings();
  }

  async clearRecent() {
    this.settings.recentBg = [];
    this.settings.recentText = [];
    await this.saveSettings();
  }

  /** rgb of any CSS colour (keywords, hsl) via the browser, cached. */
  resolveColour(v) {
    if (this.colourCache.has(v)) return this.colourCache.get(v);
    let rgb = null;
    try {
      const probe = document.body.createSpan();
      probe.style.color = v;
      rgb = probe.style.color ? colorToRgb(getComputedStyle(probe).color) : null;
      probe.remove();
    } catch (e) {
      rgb = null;
    }
    this.colourCache.set(v, rgb);
    return rgb;
  }

  cssOpts() {
    return {
      strength: this.settings.strength,
      drag: this.drag,
      autoText: this.settings.autoText,
      resolve: (v) => this.resolveColour(v),
    };
  }

  /* ---------- rendering ---------- */

  /** Attach or refresh the <style> of one rendered table. */
  applyTable(tableEl, table, kind, host, ctx) {
    if (!tableEl.dataset.tcsId) tableEl.dataset.tcsId = String(this.nextId++);
    let entry = this.entries.get(tableEl);
    if (!entry) {
      entry = { table, kind, host, ctx: null, styleEl: null };
      this.entries.set(tableEl, entry);
    }
    entry.table = table;
    entry.kind = kind;
    entry.host = host;
    entry.ctx = ctx || null;
    if (kind === 'live') this.liveTables.add(tableEl);
    this.paint(tableEl, entry);
    this.wireTable(tableEl);
  }

  paint(tableEl, entry) {
    const css = buildCss(tableEl, entry.table, this.cssOpts());
    if (!css) {
      if (entry.styleEl) entry.styleEl.remove();
      entry.styleEl = null;
      return;
    }
    const doc = tableEl.ownerDocument;
    if (!entry.styleEl) {
      entry.styleEl = doc.createElement('style');
      entry.styleEl.setAttribute('data-tcs-for', tableEl.dataset.tcsId);
    }
    // Live preview widgets are rebuilt by Obsidian, so their styles sit in <head>;
    // reading view sections are cached and re-attached, so their style travels with them.
    const parent = entry.kind === 'live' ? doc.head : entry.host || tableEl.parentElement;
    if (entry.styleEl.parentNode !== parent) parent.appendChild(entry.styleEl);
    if (entry.styleEl.textContent !== css) entry.styleEl.textContent = css;
  }

  repaint(tableEl) {
    const entry = this.entries.get(tableEl);
    if (entry) this.paint(tableEl, entry);
  }

  refreshAll() {
    for (const d of this.openDocuments()) d.querySelectorAll('table[data-tcs-id]').forEach((t) => this.repaint(t));
  }

  processReading(el, ctx) {
    if (!el.querySelector('table') || el.closest('.cm-table-widget')) return;
    this.syncReading(el, ctx);
  }

  /**
   * Restyle the tables of one reading-view section from the note's current text.
   *
   * Reading view keeps a section's old DOM when its rendered HTML is unchanged, and our
   * %%{...}%% tokens never reach the HTML. So a style-only edit does not re-run the
   * post-processor; we have to re-read the section ourselves (on our own edits, mode
   * switches and file changes). getSectionInfo() always reports the section's current lines.
   */
  syncReading(host, ctx, text) {
    const tables = host.querySelectorAll('table');
    if (!tables.length) return;
    const info = ctx.getSectionInfo(host);
    if (!info) return;
    const lines = (typeof text === 'string' ? text : info.text).split('\n');
    const src = { count: lines.length, get: (i) => lines[i] };
    const found = findTablesInRange(src, info.lineStart, info.lineEnd);
    tables.forEach((tableEl, k) => {
      if (found[k]) this.applyTable(tableEl, found[k], 'reading', host, ctx);
    });
  }

  /** Re-sync every reading-view table on screen (twice: Obsidian re-parses asynchronously). */
  scheduleReadingRefresh() {
    for (const t of this.refreshTimers) window.clearTimeout(t);
    this.refreshTimers = [60, 500].map((ms) => window.setTimeout(() => this.refreshReading(), ms));
  }

  refreshReading() {
    const hosts = new Map();
    for (const d of this.openDocuments()) {
      d.querySelectorAll('table[data-tcs-id]').forEach((t) => {
        const entry = this.entries.get(t);
        if (entry && entry.kind === 'reading' && entry.ctx && t.isConnected) hosts.set(entry.host, entry.ctx);
      });
    }
    for (const [host, ctx] of hosts) {
      try {
        this.syncReading(host, ctx);
      } catch (e) {
        console.error(LOG, e);
      }
    }
  }

  openDocuments() {
    const docs = new Set([document]);
    this.app.workspace.iterateAllLeaves((leaf) => {
      const d = leaf.view && leaf.view.containerEl && leaf.view.containerEl.ownerDocument;
      if (d) docs.add(d);
    });
    return docs;
  }

  liveExtension() {
    const plugin = this;
    const { ViewPlugin } = cmView;
    return ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.view = view;
          this.frame = 0;
          this.win = view.dom.ownerDocument.defaultView || window;
          this.observer = new MutationObserver(() => this.schedule());
          this.observer.observe(view.contentDOM, { childList: true, subtree: true });
          this.schedule();
        }
        update(u) {
          if (u.docChanged || u.viewportChanged || u.geometryChanged) this.schedule();
        }
        schedule() {
          if (this.frame) return;
          this.frame = this.win.requestAnimationFrame(() => {
            this.frame = 0;
            try {
              plugin.scanLive(this.view);
            } catch (e) {
              console.error(LOG, e);
            }
          });
        }
        destroy() {
          this.observer.disconnect();
          if (this.frame) this.win.cancelAnimationFrame(this.frame);
        }
      }
    );
  }

  scanLive(view) {
    for (const t of Array.from(this.liveTables)) {
      if (!t.isConnected) {
        const entry = this.entries.get(t);
        if (entry && entry.styleEl) entry.styleEl.remove();
        this.liveTables.delete(t);
      }
    }
    const widgets = view.contentDOM.querySelectorAll('.cm-table-widget');
    if (!widgets.length) return;
    const doc = view.state.doc;
    const src = { count: doc.lines, get: (i) => doc.line(i + 1).text };
    widgets.forEach((widget) => {
      if (widget.closest('.cm-editor') !== view.dom) return;
      const tableEl = widget.querySelector('table');
      if (!tableEl) return;
      const start = this.widgetLine(view, widget);
      if (start < 0) return;
      const table = this.parseNear(src, start);
      if (table) this.applyTable(tableEl, table, 'live', null);
    });
  }

  widgetLine(view, widget) {
    try {
      return view.state.doc.lineAt(view.posAtDOM(widget)).number - 1;
    } catch (e) {
      return -1;
    }
  }

  parseNear(src, line) {
    for (let s = line; s <= line + 2 && s < src.count; s++) {
      const t = parseTableAt(src, s);
      if (t) return t;
    }
    return null;
  }

  /** The rendered <table> for the table at `startLine` (Obsidian may have rebuilt it). */
  findRendered(oldEl, startLine, scopeEl) {
    if (oldEl && oldEl.isConnected) return oldEl;
    if (!scopeEl || !scopeEl.isConnected) return null;
    for (const t of Array.from(scopeEl.querySelectorAll('table[data-tcs-id]'))) {
      const entry = this.entries.get(t);
      if (entry && entry.table && entry.table.start === startLine) return t;
    }
    return null;
  }

  /* ---------- resolving a rendered table back to its source ---------- */

  refForTable(tableEl) {
    const widget = tableEl.closest('.cm-table-widget');
    if (widget) {
      const view = this.viewForWidget(widget);
      if (!view) return null;
      const line = this.widgetLine(view, widget);
      if (line < 0) return null;
      const doc = view.state.doc;
      const t = this.parseNear({ count: doc.lines, get: (i) => doc.line(i + 1).text }, line);
      return t ? cmRef(view, t.start) : null;
    }
    const entry = this.entries.get(tableEl);
    if (!entry || entry.kind !== 'reading' || !entry.ctx) return null;
    const { host, ctx } = entry;
    this.syncReading(host, ctx); // the table may have moved since it was drawn
    if (!entry.table) return null;
    return fileRef(this.app, ctx.sourcePath, entry.table.start, (text) => this.syncReading(host, ctx, text));
  }

  viewForWidget(widget) {
    const editorEl = widget.closest('.cm-editor');
    if (!editorEl) return null;
    if (cmView && cmView.EditorView && cmView.EditorView.findFromDOM) {
      const v = cmView.EditorView.findFromDOM(editorEl);
      if (v) return v;
    }
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (!found && v instanceof MarkdownView && v.editor && v.editor.cm && v.editor.cm.dom === editorEl) found = v.editor.cm;
    });
    return found;
  }

  /* ---------- context menu ---------- */

  styleableCell(target) {
    if (!target || typeof target.closest !== 'function') return null;
    const cell = target.closest('td, th');
    if (!cell) return null;
    const tableEl = cell.closest('table');
    if (!tableEl || !tableEl.dataset.tcsId) return null;
    return { cell, tableEl };
  }

  installMenuPatch() {
    const plugin = this;
    const proto = Menu.prototype;
    const original = proto.showAtMouseEvent;
    if (typeof original !== 'function') return;
    let active = true;
    const patched = function (evt) {
      if (active) {
        try {
          plugin.extendMenu(this, evt);
        } catch (e) {
          console.error(LOG, e);
        }
      }
      return original.apply(this, arguments);
    };
    proto.showAtMouseEvent = patched;
    this.register(() => {
      active = false;
      if (proto.showAtMouseEvent === patched) proto.showAtMouseEvent = original;
    });
  }

  extendMenu(menu, evt) {
    if (!evt || evt.type !== 'contextmenu' || menu.tcsAdded) return;
    const hit = this.styleableCell(evt.target);
    if (!hit) return;
    menu.tcsAdded = true;
    evt.tcsHandled = true;
    this.addMenuItem(menu, this.allowsColours(hit.tableEl), () => this.openFromDom(hit.tableEl, hit.cell, evt));
  }

  /** Colours are edited in Live Preview and Source mode; Reading view only adjusts widths. */
  allowsColours(tableEl) {
    return !tableEl || !!tableEl.closest('.cm-table-widget');
  }

  addMenuItem(menu, colours, onClick) {
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(colours ? 'Cell style…' : 'Column width…')
        .setIcon(colours ? 'palette' : 'move-horizontal')
        .onClick(onClick)
    );
  }

  /** Reading view may show no menu at all for a table cell; then show our own. */
  onContextMenuFallback(evt) {
    const hit = this.styleableCell(evt.target);
    if (!hit || hit.tableEl.closest('.cm-table-widget')) return;
    const win = evt.view || window;
    win.setTimeout(() => {
      if (evt.tcsHandled) return;
      const menu = new Menu();
      menu.tcsAdded = true;
      menu.addItem((item) =>
        item.setTitle('Column width…').setIcon('move-horizontal').onClick(() => this.openFromDom(hit.tableEl, hit.cell, evt))
      );
      menu.showAtPosition({ x: evt.clientX, y: evt.clientY }, hit.cell.ownerDocument);
    }, 0);
  }

  /** Source mode: Obsidian's editor menu, cursor inside a table. */
  onEditorMenu(menu, editor, info) {
    if (menu.tcsAdded || !(info instanceof MarkdownView)) return;
    const state = info.getState ? info.getState() : {};
    if (info.getMode() !== 'source' || !state.source) return; // live preview goes through the DOM
    const found = this.tableAtCursor(editor);
    if (!found) return;
    menu.tcsAdded = true;
    this.addMenuItem(menu, true, () => this.openFromEditor(editor, found));
  }

  /* ---------- opening the popover ---------- */

  openFromDom(tableEl, cell, evt) {
    const ref = this.refForTable(tableEl);
    if (!ref) {
      new Notice('Table Styler: could not find this table in the note.');
      return;
    }
    const pos = (c) => ({
      r: Array.prototype.indexOf.call(tableEl.rows, c.parentElement),
      c: Array.prototype.indexOf.call(c.parentElement.cells, c),
    });
    const selected = Array.from(tableEl.querySelectorAll('th.is-selected, td.is-selected'));
    const cells = selected.length > 1 && selected.includes(cell) ? selected : [cell];
    const targets = cells.map(pos).filter((t) => t.r >= 0 && t.c >= 0);
    new StylePopover(this, {
      doc: cell.ownerDocument,
      x: evt.clientX,
      y: evt.clientY,
      ref,
      targets,
      tableEl,
      colours: this.allowsColours(tableEl),
    }).open();
  }

  tableAtCursor(editor) {
    const src = { count: editor.lineCount(), get: (i) => editor.getLine(i) };
    const cur = editor.getCursor();
    const table = findTableAround(src, cur.line);
    return table ? { table, src } : null;
  }

  openFromEditor(editor, found) {
    const targets = targetsBetween(found.table, editor.getCursor('from'), editor.getCursor('to'));
    let x = window.innerWidth / 2 - 140;
    let y = window.innerHeight / 3;
    const cmv = editor.cm;
    if (cmv && typeof cmv.coordsAtPos === 'function') {
      try {
        const co = cmv.coordsAtPos(editor.posToOffset(editor.getCursor('to')));
        if (co) {
          x = co.left;
          y = co.bottom;
        }
      } catch (e) {
        /* keep the fallback position */
      }
    }
    new StylePopover(this, {
      doc: (cmv && cmv.dom && cmv.dom.ownerDocument) || activeDocument,
      x,
      y,
      ref: editorRef(editor, found.table.start),
      targets,
      tableEl: null,
    }).open();
  }

  /* ---------- column resizing by dragging the column edge ---------- */

  edgeColumn(tableEl, evt) {
    const t = evt.target;
    if (!t || typeof t.closest !== 'function') return -1;
    const cell = t.closest('td, th');
    if (!cell || cell.closest('table') !== tableEl) return -1;
    if (t.closest('.table-col-drag-handle, .table-row-drag-handle, .table-col-btn, .table-row-btn')) return -1;
    const rect = cell.getBoundingClientRect();
    const c = Array.prototype.indexOf.call(cell.parentElement.cells, cell);
    if (rect.right - evt.clientX <= EDGE_PX && rect.right - evt.clientX >= -2) return c;
    if (evt.clientX - rect.left <= EDGE_PX && c > 0) return c - 1;
    return -1;
  }

  wireTable(tableEl) {
    if (this.wired.has(tableEl)) return;
    this.wired.add(tableEl);

    tableEl.addEventListener('pointermove', (evt) => {
      if (this.drag) return;
      tableEl.toggleClass('tcs-col-edge', this.edgeColumn(tableEl, evt) >= 0);
    });
    tableEl.addEventListener('pointerleave', () => {
      if (!this.drag) tableEl.removeClass('tcs-col-edge');
    });

    tableEl.addEventListener(
      'pointerdown',
      (evt) => {
        if (evt.button !== 0 || !evt.isPrimary) return;
        const col = this.edgeColumn(tableEl, evt);
        if (col < 0) return;
        evt.preventDefault();
        evt.stopPropagation();
        this.startDrag(tableEl, col, evt);
      },
      true
    );

    // Double-click on a column edge: back to automatic width.
    tableEl.addEventListener(
      'dblclick',
      (evt) => {
        const col = this.edgeColumn(tableEl, evt);
        if (col < 0) return;
        evt.preventDefault();
        evt.stopPropagation();
        this.commitWidth(tableEl, col, null);
      },
      true
    );
  }

  startDrag(tableEl, col, evt) {
    const head = tableEl.rows[0];
    const headCell = head && head.cells[col];
    if (!headCell) return;
    const doc = tableEl.ownerDocument;
    const win = doc.defaultView || window;
    const startX = evt.clientX;
    const startW = headCell.getBoundingClientRect().width;
    this.drag = { table: tableEl, col, width: Math.round(startW), moved: false };
    doc.body.addClass('tcs-resizing');

    const move = (e) => {
      if (!this.drag) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 2) this.drag.moved = true;
      this.drag.width = Math.max(MIN_COL_PX, Math.round(startW + dx));
      this.repaint(tableEl);
    };
    const up = (e) => {
      win.removeEventListener('pointermove', move, true);
      win.removeEventListener('pointerup', up, true);
      win.removeEventListener('pointercancel', up, true);
      doc.body.removeClass('tcs-resizing');
      const drag = this.drag;
      this.drag = null;
      if (e && e.type === 'pointerup') {
        e.preventDefault();
        e.stopPropagation();
      }
      if (!drag || !drag.moved || e.type === 'pointercancel') {
        this.repaint(tableEl);
        return;
      }
      this.commitWidth(tableEl, col, drag.width + 'px', drag.width);
    };
    win.addEventListener('pointermove', move, true);
    win.addEventListener('pointerup', up, true);
    win.addEventListener('pointercancel', up, true);
  }

  async commitWidth(tableEl, col, width, holdPx) {
    // Keep showing the dragged width until the note re-renders with the new token.
    if (holdPx) this.drag = { table: tableEl, col, width: holdPx, moved: true, holding: true };
    try {
      const ref = this.refForTable(tableEl);
      if (!ref) throw new Error('could not find this table in the note');
      const src = await ref.load();
      const table = parseTableAt(src, ref.startLine);
      if (!table) throw new Error('could not find this table in the note');
      const change = cellEdit(table, 0, col, (st) => {
        if (width) st.width = width;
        else delete st.width;
      });
      if (change) await ref.apply([change]);
    } catch (e) {
      console.error(LOG, e);
      new Notice('Table Styler: ' + e.message);
    } finally {
      if (this.drag && this.drag.holding && this.drag.table === tableEl) this.drag = null;
      if (tableEl.isConnected) this.repaint(tableEl);
    }
  }
}

// Pure helpers, exposed for tests.
TableStylerPlugin.core = {
  readCell,
  writeCell,
  stripTokens,
  formatToken,
  parseDecls,
  cellRanges,
  parseTableAt,
  findTablesInRange,
  findTableAround,
  cellEdit,
  applyLineChanges,
  targetsBetween,
  bgValue,
  fgValue,
  widthValue,
  isSafeColor,
  buildCss,
  colorToRgb,
  autoTextColor,
  normalizeSettings,
};

module.exports = TableStylerPlugin;
module.exports.default = TableStylerPlugin;

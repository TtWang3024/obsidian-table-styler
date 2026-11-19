/*
 * Unit tests for the pure parts of main.js (table parsing, style tokens, CSS, colours).
 * No Node needed: run with the JavaScript engine built into macOS, from the plugin folder:
 *   osascript -l JavaScript tests/core-test.js main.js
 */
ObjC.import('Foundation');
function readFile(p) { return $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null).js; }
function run(argv) {
  const src = readFile(argv[0]);
  class Base {}
  const stub = {
    Plugin: Base, PluginSettingTab: Base, Setting: Base, MarkdownView: Base, Notice: Base, TFile: Base,
    Menu: class { showAtMouseEvent() {} }, setIcon() {},
  };
  const req = (name) => { if (name === 'obsidian') return stub; throw new Error('no ' + name); };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', src)(req, module, module.exports);
  const P = module.exports.default;
  const C = P.core;
  const out = [];
  let fails = 0;
  const eq = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) out.push('ok   ' + name); else { fails++; out.push('FAIL ' + name + '\n     got  ' + g + '\n     want ' + w); }
  };
  const S = (text) => { const lines = text.split('\n'); return { count: lines.length, get: (i) => lines[i], lines }; };
  const cellsText = (line) => (C.cellRanges(line) || []).map((c) => line.slice(c.cs, c.ce));

  // Row splitting
  eq('split basic', cellsText('| a | b |'), ['a', 'b']);
  eq('split no outer pipes', cellsText('a | b'), ['a', 'b']);
  eq('split escaped pipe', cellsText('| a \\| x | b |'), ['a \\| x', 'b']);
  eq('split wikilink alias', cellsText('| [[N\\|alias]] | 2 |'), ['[[N\\|alias]]', '2']);
  eq('split empty cell', cellsText('| a |  | c |'), ['a', '', 'c']);
  eq('split callout prefix', cellsText('> | a | b |'), ['a', 'b']);
  eq('split crlf', cellsText('| a | b |\r'), ['a', 'b']);
  eq('no pipe', C.cellRanges('just text'), null);

  // Tokens
  eq('read token', C.readCell('Ann %%{bg:yellow; color:red}%%'), { bg: 'yellow', color: 'red' });
  eq('read aliases', C.readCell('x %%{background: #fff; text: blue; w: 120}%%'), { bg: '#fff', color: 'blue', width: '120' });
  eq('read percent width', C.readCell('Name %%{width:40%}%%'), { width: '40%' });
  eq('read two tokens, later wins', C.readCell('%%{bg:red}%% x %%{bg:blue}%%'), { bg: 'blue' });
  eq('plain comment ignored', C.readCell('x %%note%%'), {});
  eq('write adds token', C.writeCell('Ann', { bg: 'yellow' }), 'Ann %%{bg:yellow}%%');
  eq('write replaces token', C.writeCell('Ann %%{bg:yellow}%%', { bg: 'green', color: 'red' }), 'Ann %%{bg:green; color:red}%%');
  eq('write removes token', C.writeCell('Ann %%{bg:yellow}%%', {}), 'Ann');
  eq('write empty cell', C.writeCell('', { bg: 'red' }), '%%{bg:red}%%');
  eq('write keeps user comment', C.writeCell('x %%note%%', { bg: 'red' }), 'x %%note%% %%{bg:red}%%');

  // Table parsing and edits
  const doc = [
    'Intro',
    '',
    '| Name | Score |',
    '| :--- | ---: |',
    '| Ann %%{bg:yellow}%% | 12 |',
    '| Bob | 7 |',
    '',
    'After',
  ].join('\n');
  const s = S(doc);
  const t = C.parseTableAt(s, 2);
  eq('table bounds', [t.start, t.delimLine, t.end, t.rows.length, t.columns], [2, 3, 5, 3, 2]);
  eq('table styles', t.rows.map((r) => r.styles), [[{}, {}], [{ bg: 'yellow' }, {}], [{}, {}]]);
  eq('not a table at delimiter', C.parseTableAt(s, 3), null);
  eq('find around body line', C.findTableAround(s, 5).start, 2);
  eq('find around outside', C.findTableAround(s, 7), null);
  eq('tables in range', C.findTablesInRange(s, 0, 7).map((x) => x.start), [2]);

  const e1 = C.cellEdit(t, 0, 0, (st) => (st.width = '160px'));
  const e2 = C.cellEdit(t, 2, 1, (st) => (st.color = 'red'));
  const e3 = C.cellEdit(t, 1, 0, (st) => delete st.bg);
  const e4 = C.cellEdit(t, 1, 1, (st) => delete st.bg); // no-op
  eq('no-op edit is null', e4, null);
  const after = C.applyLineChanges(doc, [e1, e2, e3]);
  eq('edited text', after.split('\n').slice(2, 6), [
    '| Name %%{width:160px}%% | Score |',
    '| :--- | ---: |',
    '| Ann | 12 |',
    '| Bob | 7 %%{color:red}%% |',
  ]);
  const t2 = C.parseTableAt(S(after), 2);
  eq('reparse after edit', [t2.rows[0].styles[0], t2.rows[2].styles[1]], [{ width: '160px' }, { color: 'red' }]);

  // Two edits on one line in one batch
  const both = C.applyLineChanges(doc, [C.cellEdit(t, 2, 0, (st) => (st.bg = 'blue')), C.cellEdit(t, 2, 1, (st) => (st.bg = 'green'))]);
  eq('two edits one line', both.split('\n')[5], '| Bob %%{bg:blue}%% | 7 %%{bg:green}%% |');

  // Callout table
  const cdoc = '> [!note]\n> | a | b |\n> | - | - |\n> | 1 | 2 |\n';
  const ct = C.findTablesInRange(S(cdoc), 0, 4);
  eq('callout table found', ct.map((x) => [x.start, x.end]), [[1, 3]]);
  eq('callout edit', C.applyLineChanges(cdoc, [C.cellEdit(ct[0], 1, 1, (st) => (st.bg = 'red'))]).split('\n')[3], '> | 1 | 2 %%{bg:red}%% |');

  // Empty cell edit
  const edoc = '| a | b |\n| - | - |\n|   | x |';
  const et = C.parseTableAt(S(edoc), 0);
  eq('empty cell edit', C.applyLineChanges(edoc, [C.cellEdit(et, 1, 0, (st) => (st.bg = 'red'))]).split('\n')[2], '| %%{bg:red}%%  | x |');

  // Cursor rectangle
  eq('targets one cell', C.targetsBetween(t, { line: 4, ch: 3 }, { line: 4, ch: 3 }), [{ r: 1, c: 0 }]);
  eq('targets block', C.targetsBetween(t, { line: 2, ch: 2 }, { line: 5, ch: 9 }).length, 6);

  // Values
  eq('bg named', C.bgValue('red', 0.22), 'rgba(var(--color-red-rgb), 0.22)');
  eq('bg hex', C.bgValue('#e0f2fe', 0.22), '#e0f2fe');
  eq('bg injection rejected', C.bgValue('red;}body{display:none', 0.22), null);
  eq('fg named', C.fgValue('Blue'), 'var(--color-blue)');
  eq('width px default', C.widthValue('120'), '120px');
  eq('width percent', C.widthValue('40%'), '40%');
  eq('width junk', C.widthValue('12px;color:red'), null);

  // CSS with a fake DOM
  const mkRow = (tag, index) => { const parent = { tagName: tag, children: [] }; const tr = { parentElement: parent }; parent.children[index] = tr; for (let i = 0; i < index; i++) parent.children[i] = {}; return tr; };
  const fakeTable = { dataset: { tcsId: '7' }, rows: [mkRow('THEAD', 0), mkRow('TBODY', 0), mkRow('TBODY', 1)] };
  const css = C.buildCss(fakeTable, t2, { strength: 0.2, drag: null });
  eq('css rules', css.split('\n'), [
    'table[data-tcs-id="7"] tr > :nth-child(1){width:160px!important;min-width:160px!important;max-width:160px!important;box-sizing:border-box;overflow-wrap:anywhere;}',
    'table[data-tcs-id="7"] > tbody > tr:nth-child(2) > :nth-child(2){color:var(--color-red)!important}',
  ]);
  const css2 = C.buildCss(fakeTable, t2, { strength: 0.2, drag: { table: fakeTable, col: 1, width: 222 } });
  eq('css drag override', css2.indexOf(':nth-child(2){width:222px') > 0, true);


  // Colour parsing and automatic text colour
  eq('rgb from hex', C.colorToRgb('#1E3A8A'), { r: 30, g: 58, b: 138, a: 1 });
  eq('rgb from short hex', C.colorToRgb('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  eq('rgb from rgba', C.colorToRgb('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  eq('rgb from css4 rgb', C.colorToRgb('rgb(10 20 30 / 40%)'), { r: 10, g: 20, b: 30, a: 0.4 });
  eq('auto: navy hex -> white', C.autoTextColor('#1e3a8a'), '#ffffff');
  eq('auto: saturated red -> white', C.autoTextColor('#e93147'), '#ffffff');
  eq('auto: light yellow -> dark', C.autoTextColor('#ffd966'), '#1f1f1f');
  eq('auto: light blue -> dark', C.autoTextColor('#e0f2fe'), '#1f1f1f');
  eq('auto: palette name untouched', C.autoTextColor('blue'), null);
  eq('auto: transparent fill untouched', C.autoTextColor('#00000033'), null);
  eq('auto: keyword uses resolver', C.autoTextColor('rgb(0, 0, 0)'), '#ffffff');
  const dark = C.parseTableAt(S('| a | b |\n| - | - |\n| x %%{bg:#1e3a8a}%% | y %%{bg:#1e3a8a; color:yellow}%% |'), 0);
  const fake2 = { dataset: { tcsId: '9' }, rows: [mkRow('THEAD', 0), mkRow('TBODY', 0)] };
  eq('css auto white text', C.buildCss(fake2, dark, { strength: 0.2, autoText: true }).split('\n'), [
    'table[data-tcs-id="9"] > tbody > tr:nth-child(1) > :nth-child(1){background-color:#1e3a8a!important;color:#ffffff!important}',
    'table[data-tcs-id="9"] > tbody > tr:nth-child(1) > :nth-child(2){background-color:#1e3a8a!important;color:var(--color-yellow)!important}',
  ]);
  eq('css auto text off', C.buildCss(fake2, dark, { strength: 0.2, autoText: false }).split('\n')[0].indexOf('color:#fff') < 0, true);

  // Settings migration
  const migrated = C.normalizeSettings({ strength: 0.3, recent: ['#112233', 'not a colour', '#445566'] });
  eq('settings migrate', [migrated.recentBg, migrated.recentText, migrated.commonBg.length, migrated.autoText, 'recent' in migrated],
    [['#112233', '#445566'], ['#112233', '#445566'], 10, true, false]);
  eq('settings keep empty common', C.normalizeSettings({ commonBg: [], commonText: ['red', '#abc', 'bad;}'] }).commonText, ['red', '#abc']);

  // Palette upgrade: old 9-colour defaults gain black / white once; a later removal is respected.
  const OLD = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'gray'];
  const up = C.normalizeSettings({ commonBg: OLD.slice(), commonText: OLD.slice() });
  eq('upgrade adds black and white', [up.commonBg.slice(-1)[0], up.commonText.slice(-1)[0], up.commonBg.length, up.paletteVersion], ['black', 'white', 10, 2]);
  const kept = C.normalizeSettings({ commonBg: OLD.slice(), commonText: OLD.slice(), paletteVersion: 2 });
  eq('upgrade runs only once', kept.commonBg.length, 9);
  const custom = C.normalizeSettings({ commonBg: ['red', '#123456'], commonText: OLD.slice(0, 3) });
  eq('edited lists untouched', [custom.commonBg, custom.commonText.length], [['red', '#123456'], 3]);
  const fresh = C.normalizeSettings({});
  eq('fresh defaults', [fresh.commonBg.length, fresh.commonText.length, fresh.commonBg[9], fresh.commonText[9]], [10, 10, 'black', 'white']);
  out.push(fails ? fails + ' FAILED' : 'all passed');
  return out.join('\n');
}

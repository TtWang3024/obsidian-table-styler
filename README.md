# Table Styler

An Obsidian plugin for Markdown tables: fix column widths and give cells background and text colours.

- **Column widths.** Drag the right edge of a column to fix its width; double-click the edge to make it automatic again. Or type a width in the panel, or fix every column at its current width in one click.
- **Cell colours.** Right-click a cell and choose **Cell style…**. Apply a background or text colour to the cell, the whole row, the whole column, or a block of selected cells.
- **Your own palette.** Each colour section has a Common row you can edit (pencil button: × removes, + adds) and a Recent row with the last five colours you used, custom colours included.
- **Readable text.** On a custom fill, text turns white on dark colours and near-black on light ones, unless the cell has its own text colour.
- **Theme aware.** The named colours (red, orange, yellow, green, cyan, blue, purple, pink, gray) are soft tints that follow your light or dark theme.

Colours are edited in Live Preview and Source mode. Reading view shows them and lets you adjust column widths.

## How styles are stored

Styles live inside the table cells as Obsidian comments, which Reading view hides:

```markdown
| Sample %%{width:120px}%% | Yield                |
| ------------------------ | -------------------- |
| MOF-5 %%{bg:green}%%     | 82 % %%{color:red}%% |
| ZIF-8 %%{bg:#1e3a8a}%%   | 64 %                 |
```

- `bg` and `color` take a palette name (`red`, `blue`, ...) or any CSS colour (`#e0f2fe`, `black`, `rgb(...)`).
- `width` is read from the header cell only and fixes the whole column (`120px`, `12em`, `30%`; a bare number means pixels).

Because each style sits in its own cell, it moves with the cell when rows or columns are moved, sorted or inserted, by Obsidian's table editor or by hand. You can also edit the comments directly in Source mode. Without the plugin, the table still renders normally and the comments stay hidden.

## Installing

Until the plugin is in the community list, install it by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release (or from this repository).
2. Put them in `<your vault>/.obsidian/plugins/table-styler/`.
3. In Obsidian, open Settings → Community plugins, refresh the list and enable **Table Styler**.

With the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin you can instead add `TtWang3024/obsidian-table-styler` as a beta plugin.

## Settings

- **Background strength**: how strong the palette tints are.
- **Automatic text colour**: white or dark text on custom fills.
- **Colour lists**: reset the common colours and clear the recent ones.

## Development

`main.js` is written by hand as plain CommonJS; there is no build step. The parser and CSS logic have unit tests that run with the JavaScript engine built into macOS:

```bash
osascript -l JavaScript tests/core-test.js main.js
```

## Credits

The idea of keeping table data inside the note itself comes from [Advanced Tables](https://github.com/tgrosinger/advanced-tables-obsidian) by Tony Grosinger. No code was copied from it.

## Licence

MIT

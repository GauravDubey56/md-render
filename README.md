# local-md-render

Local viewer for every markdown file under a folder. No dependencies to install.

```bash
npx local-md-render                  # scans the current folder, opens http://localhost:4321
npx local-md-render ~/notes          # scan a different folder
npx local-md-render --port 5000      # different port (default 4321; the next free one if it's taken)
npx local-md-render --no-open        # don't open the browser
npx local-md-render --host 0.0.0.0   # share on your network (default: localhost only)
```

Or install it globally with `npm i -g local-md-render` and run `local-md-render`. From a clone of this repo, run `npm start` or `node server.js [dir]`.

On start it recursively finds `.md` / `.markdown` / `.mdx` files, skipping `node_modules`, `.git`, `dist`, `build`, `coverage`, `vendor` and similar folders. It watches for changes and live-reloads the open file. Use ⟳ to rescan.

## Copying out

| What | How | Pastes as |
|---|---|---|
| Whole document | **Copy for Docs** | Rich text, with tables as real tables and diagrams as images (Google Docs, Word, Notion, Confluence) |
| One section | Hover a heading, click ⧉ | Same as above, for that heading and its content |
| Any selection | Normal Cmd/Ctrl+C | Same rich format (diagrams in the selection become images) |
| Table | Hover → Copy table / Markdown / CSV / ⬇ CSV | Rich table, or TSV that lands in separate cells in Sheets/Excel |
| Mermaid diagram | Hover → Copy image / ⬇ PNG / ⬇ SVG / Source | PNG image (2× resolution, white background) |
| Code block | Hover → Copy | Plain text |
| Raw source | **Copy Markdown** / **Copy Text** | Plain text |
| PDF | **Print / PDF** | Browser print dialog (sidebar and buttons are hidden) |

Keyboard: `/` focuses the file filter, `Enter` opens the first match, `Esc` clears the filter.

The viewer loads marked, highlight.js and mermaid from jsDelivr, so the first load needs internet access.

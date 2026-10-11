/* global marked, hljs, mermaid */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const state = {
    files: [],
    fileSet: new Set(),
    rootName: '',
    current: null, // root-relative path of the open file
    source: '',    // raw markdown of the open file
    renderSeq: 0,
  };

  const contentEl = $('#content');
  const treeEl = $('#tree');
  const filterEl = $('#filter');

  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    fontFamily: 'Arial, Helvetica, sans-serif',
    // Plain SVG <text> labels instead of <foreignObject> HTML, so the
    // diagram can be rasterised to PNG without tainting the canvas.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  });

  // ---------------------------------------------------------------- toast
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), 2200);
  }

  // ------------------------------------------------------------ clipboard
  // `parts` maps MIME type -> string | Blob | Promise of either. The
  // ClipboardItem is created synchronously so Safari keeps the user gesture.
  async function writeClipboard(parts, label) {
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) {
        const item = {};
        for (const [type, v] of Object.entries(parts)) {
          item[type] = Promise.resolve(v).then((x) => (x instanceof Blob ? x : new Blob([x], { type })));
        }
        await navigator.clipboard.write([new ClipboardItem(item)]);
      } else {
        await navigator.clipboard.writeText(await (parts['text/plain'] || ''));
      }
      toast(`Copied ${label}`);
    } catch (err) {
      console.error(err);
      toast(`Copy failed: ${err.message}`, true);
    }
  }

  // ------------------------------------------------------ diagram -> PNG
  async function svgToPng(svg, scale = 2) {
    const vb = svg.viewBox?.baseVal;
    const rect = svg.getBoundingClientRect();
    const w = Math.ceil(vb?.width || rect.width || 800);
    const h = Math.ceil(vb?.height || rect.height || 600);

    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    clone.style.maxWidth = 'none';

    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return { blob, dataUrl: canvas.toDataURL('image/png'), width: w, height: h };
  }

  // Cache of rendered PNGs keyed by the diagram's svg id; the sync "copy"
  // event handler needs these ready ahead of time.
  const pngCache = new Map();
  function diagramPng(svg) {
    let entry = pngCache.get(svg.id);
    if (!entry) {
      entry = svgToPng(svg).catch((error) => ({ error }));
      entry.then((v) => { entry.settled = true; entry.value = v; });
      pngCache.set(svg.id, entry);
    }
    return entry;
  }

  function download(blobOrUrl, filename) {
    const a = document.createElement('a');
    a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    a.download = filename;
    a.click();
    if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const baseName = () => (state.current || 'document').split('/').pop().replace(/\.\w+$/, '');

  // ---------------------------------------------- export to rich HTML
  // Docs editors (Google Docs, Word, Notion, Confluence) drop CSS classes,
  // so everything gets inline styles, and diagrams become PNG <img>s.
  const S = {
    table: 'border-collapse:collapse;margin:8px 0;',
    th: 'border:1px solid #c8ccd1;padding:6px 10px;background:#f3f4f6;font-weight:bold;text-align:left;vertical-align:top;',
    td: 'border:1px solid #c8ccd1;padding:6px 10px;vertical-align:top;',
    pre: 'background:#f6f8fa;border:1px solid #e1e4e8;border-radius:4px;padding:10px;font-family:Consolas,Menlo,monospace;font-size:10pt;white-space:pre-wrap;',
    code: 'font-family:Consolas,Menlo,monospace;background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:90%;',
    blockquote: 'border-left:4px solid #d0d7de;margin:0 0 12px;padding:0 12px;color:#57606a;',
  };

  function pngFromCache(svgId) {
    const p = pngCache.get(svgId);
    return p && p.settled ? p.value : null;
  }

  // Transforms a detached container in place into docs-friendly HTML.
  function toDocsHtml(container) {
    $$('.block-bar, .sec-copy, .col-resizer', container).forEach((el) => el.remove());

    $$('svg[id^="mmd-"]', container).forEach((svg) => {
      const png = pngFromCache(svg.id);
      const holder = svg.closest('.diagram-block') || svg;
      if (png && !png.error) {
        const img = document.createElement('img');
        img.src = png.dataUrl;
        const w = Math.min(png.width, 640);
        img.width = w;
        img.height = Math.round(png.height * (w / png.width));
        img.alt = 'diagram';
        const p = document.createElement('p');
        p.appendChild(img);
        holder.replaceWith(p);
      } else {
        holder.remove();
      }
    });

    // unwrap remaining block wrappers
    $$('.block, .table-scroll', container).forEach((b) => b.replaceWith(...b.childNodes));

    $$('table', container).forEach((t) => t.setAttribute('style', S.table));
    // keep column widths the user dragged to
    $$('th', container).forEach((c) => c.setAttribute('style', S.th + (c.style.textAlign ? `text-align:${c.style.textAlign};` : '') + (c.style.width ? `width:${c.style.width};` : '')));
    $$('td', container).forEach((c) => c.setAttribute('style', S.td + (c.style.textAlign ? `text-align:${c.style.textAlign};` : '')));
    $$('pre', container).forEach((pre) => {
      pre.setAttribute('style', S.pre);
      const code = $('code', pre);
      if (code) { code.removeAttribute('class'); code.removeAttribute('style'); }
    });
    $$('code', container).forEach((c) => { if (!c.closest('pre')) c.setAttribute('style', S.code); });
    $$('blockquote', container).forEach((b) => b.setAttribute('style', S.blockquote));
    $$('a[href]', container).forEach((a) => (a.href = a.href)); // absolutise
    $$('img[src]', container).forEach((i) => { if (!i.src.startsWith('data:')) i.src = i.src; });
    $$('[id]', container).forEach((el) => el.removeAttribute('id'));
    $$('[class]', container).forEach((el) => el.removeAttribute('class'));
    return container;
  }

  function plainText(container) {
    // innerText needs layout, so measure off-screen.
    container.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;';
    document.body.appendChild(container);
    const text = container.innerText;
    container.remove();
    return text;
  }

  function exportNodes(nodes) {
    const div = document.createElement('div');
    nodes.forEach((n) => div.appendChild(n.cloneNode(true)));
    return docsPayload(div);
  }

  function docsPayload(div) {
    toDocsHtml(div);
    const html = `<meta charset="utf-8"><div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.5;">${div.innerHTML}</div>`;
    return { html, text: plainText(div) };
  }

  async function waitForDiagrams(root) {
    await Promise.all($$('svg[id^="mmd-"]', root).map((svg) => diagramPng(svg)));
  }

  // ------------------------------------------------------ table helpers
  const cellText = (c) => c.innerText.replace(/\s*\n\s*/g, ' ').trim();
  const tableRows = (t) => $$('tr', t).map((tr) => $$('th,td', tr).map(cellText));

  function tableToTsv(t) {
    return tableRows(t).map((r) => r.map((c) => c.replace(/\t/g, ' ')).join('\t')).join('\n');
  }
  function tableToCsv(t) {
    return tableRows(t)
      .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
      .join('\n');
  }
  function tableToMarkdown(t) {
    const rows = tableRows(t);
    if (!rows.length) return '';
    const esc = (c) => c.replace(/\|/g, '\\|');
    const aligns = [...t.querySelector('tr').children].map((c) => {
      const a = c.style.textAlign || c.getAttribute('align');
      return a === 'center' ? ':---:' : a === 'right' ? '---:' : '---';
    });
    const line = (r) => `| ${r.map(esc).join(' | ')} |`;
    return [line(rows[0]), `| ${aligns.join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  }

  // --------------------------------------------------------- decorators
  function bar(buttons) {
    const b = document.createElement('div');
    b.className = 'block-bar';
    for (const [label, title, fn] of buttons) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      b.appendChild(btn);
    }
    return b;
  }

  function wrap(el, cls) {
    const w = document.createElement('div');
    w.className = 'block ' + cls;
    el.replaceWith(w);
    w.appendChild(el);
    return w;
  }

  // Drag the right edge of a header cell to resize that column;
  // double-click an edge to go back to automatic widths.
  function makeResizable(table) {
    const head = table.querySelector('tr');
    if (!head) return;
    const cells = [...head.children];
    const freeze = () => {
      if (table.classList.contains('resized')) return;
      const widths = cells.map((c) => c.getBoundingClientRect().width);
      cells.forEach((c, i) => (c.style.width = widths[i] + 'px'));
      table.style.width = widths.reduce((a, b) => a + b, 0) + 'px';
      table.classList.add('resized');
    };
    const reset = () => {
      cells.forEach((c) => (c.style.width = ''));
      table.style.width = '';
      table.classList.remove('resized');
    };
    for (const cell of cells) {
      const grip = document.createElement('span');
      grip.className = 'col-resizer';
      grip.title = 'Drag to resize column · double-click to reset';
      cell.appendChild(grip);
      grip.addEventListener('dblclick', (e) => { e.stopPropagation(); reset(); });
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        freeze();
        const startX = e.clientX;
        const startCell = cell.getBoundingClientRect().width;
        const startTable = table.getBoundingClientRect().width;
        grip.setPointerCapture(e.pointerId);
        document.body.classList.add('col-resizing');
        const move = (ev) => {
          const w = Math.max(48, startCell + ev.clientX - startX);
          cell.style.width = w + 'px';
          table.style.width = startTable + (w - startCell) + 'px';
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          grip.removeEventListener('pointercancel', up);
          document.body.classList.remove('col-resizing');
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
      });
    }
  }

  function decorateTable(table) {
    const w = wrap(table, 'table-block');
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    table.replaceWith(scroll);
    scroll.appendChild(table);
    makeResizable(table);
    w.prepend(bar([
      ['Copy table', 'Rich table for Google Docs / Word / Sheets / Excel', () => {
        const { html } = exportNodes([table]);
        writeClipboard({ 'text/html': html, 'text/plain': tableToTsv(table) }, 'table');
      }],
      ['Markdown', 'Copy as a markdown table', () => writeClipboard({ 'text/plain': tableToMarkdown(table) }, 'table as markdown')],
      ['CSV', 'Copy as CSV', () => writeClipboard({ 'text/plain': tableToCsv(table) }, 'table as CSV')],
      ['⬇ CSV', 'Download as .csv', () => download(new Blob([tableToCsv(table)], { type: 'text/csv' }), `${baseName()}-table.csv`)],
    ]));
  }

  function decorateCode(pre) {
    const code = $('code', pre);
    try { hljs.highlightElement(code); } catch { /* unknown language */ }
    const w = wrap(pre, 'code-block');
    w.prepend(bar([
      ['Copy', 'Copy code', () => writeClipboard({ 'text/plain': code.textContent }, 'code')],
    ]));
  }

  let diagramSeq = 0;
  async function renderDiagram(pre, seq) {
    const src = $('code', pre).textContent;
    const w = document.createElement('div');
    w.className = 'block diagram-block';
    pre.replaceWith(w);
    const id = `mmd-${++diagramSeq}`;
    try {
      const { svg } = await mermaid.render(id, src);
      if (seq !== state.renderSeq) return;
      w.innerHTML = svg;
    } catch (err) {
      $(`#d${id}`)?.remove(); // mermaid leaves an error node behind
      w.innerHTML = '';
      const e = document.createElement('div');
      e.className = 'diagram-error';
      e.textContent = `Mermaid error: ${err.message || err}\n\n${src}`;
      w.appendChild(e);
      return;
    }
    const svgEl = $('svg', w);
    const entry = diagramPng(svgEl); // pre-render so Cmd+C and "Copy for Docs" have it ready
    const pngBlob = () => entry.then((r) => { if (r.error) throw r.error; return r.blob; });
    w.prepend(bar([
      ['Copy image', 'Copy as PNG — paste into Docs, Slides, Slack, Word…', () => writeClipboard({ 'image/png': pngBlob() }, 'diagram as image')],
      ['⬇ PNG', 'Download PNG', async () => {
        try { download(await pngBlob(), `${baseName()}-${id}.png`); } catch (e) { toast(e.message, true); }
      }],
      ['⬇ SVG', 'Download SVG', () => {
        const xml = new XMLSerializer().serializeToString(svgEl);
        download(new Blob([xml], { type: 'image/svg+xml' }), `${baseName()}-${id}.svg`);
      }],
      ['Source', 'Copy mermaid source', () => writeClipboard({ 'text/plain': src }, 'mermaid source')],
    ]));
  }

  const slug = (s, used) => {
    let base = s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') || 'section';
    let id = base, i = 1;
    while (used.has(id)) id = `${base}-${i++}`;
    used.add(id);
    return id;
  };

  function sectionNodes(h) {
    const level = +h.tagName[1];
    const nodes = [h];
    for (let n = h.nextElementSibling; n; n = n.nextElementSibling) {
      if (/^H[1-6]$/.test(n.tagName) && +n.tagName[1] <= level) break;
      nodes.push(n);
    }
    return nodes;
  }

  function decorateHeadings(root) {
    const used = new Set();
    $$('h1,h2,h3,h4,h5,h6', root).forEach((h) => {
      h.id = slug(h.textContent, used);
      const btn = document.createElement('button');
      btn.className = 'sec-copy';
      btn.textContent = '⧉';
      btn.title = 'Copy this section (rich text, tables, diagrams)';
      btn.addEventListener('click', async () => {
        const nodes = sectionNodes(h);
        const ready = waitForDiagrams(h.parentNode).then(() => exportNodes(nodes));
        writeClipboard({ 'text/html': ready.then((r) => r.html), 'text/plain': ready.then((r) => r.text) }, 'section');
      });
      h.prepend(btn);
    });
  }

  // Resolve a link/image path relative to the current file's directory.
  function resolveRel(href) {
    const dir = state.current.split('/').slice(0, -1).join('/');
    const u = new URL(href, `http://x/${dir ? dir + '/' : ''}`);
    return { path: decodeURIComponent(u.pathname.slice(1)), hash: u.hash };
  }
  const isExternal = (href) => /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);
  const viewUrl = (p) => '/view/' + p.split('/').map(encodeURIComponent).join('/');

  function rewriteLinks(root) {
    $$('img[src]', root).forEach((img) => {
      const src = img.getAttribute('src');
      if (!isExternal(src) && !src.startsWith('data:')) img.src = '/raw/' + encodeURI(resolveRel(src).path);
    });
    $$('a[href]', root).forEach((a) => {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) return;
      if (isExternal(href)) { a.target = '_blank'; a.rel = 'noopener'; return; }
      const { path, hash } = resolveRel(href);
      if (state.fileSet.has(path)) {
        a.href = viewUrl(path) + hash;
        a.dataset.internal = path;
      } else {
        a.href = '/raw/' + encodeURI(path);
        a.target = '_blank';
      }
    });
  }

  // ------------------------------------------------------------ render
  function preprocess(md) {
    // show YAML front matter as a code block rather than a stray <hr>
    return md.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/, (_m, y) => '```yaml\n' + y + '\n```\n\n');
  }

  async function render(md) {
    const seq = ++state.renderSeq;
    pngCache.clear();
    contentEl.innerHTML = marked.parse(preprocess(md), { gfm: true });

    decorateHeadings(contentEl);
    rewriteLinks(contentEl);
    $$('table', contentEl).forEach(decorateTable);

    const diagrams = [];
    $$('pre > code', contentEl).forEach((code) => {
      const pre = code.parentElement;
      if (/language-mermaid/.test(code.className)) diagrams.push(pre);
      else decorateCode(pre);
    });
    for (const pre of diagrams) {
      if (seq !== state.renderSeq) return;
      await renderDiagram(pre, seq);
    }
  }

  async function openFile(p, { push = true, keepScroll = false, hash = '' } = {}) {
    const scroll = contentEl.scrollTop;
    let res;
    try {
      res = await fetch('/api/file?p=' + encodeURIComponent(p));
    } catch (e) {
      return toast('Server unreachable', true);
    }
    if (!res.ok) {
      contentEl.innerHTML = `<div class="empty">Could not open <code>${p}</code> (${res.status}).</div>`;
      return;
    }
    state.current = p;
    state.source = await res.text();
    history[push ? 'pushState' : 'replaceState']({ p }, '', viewUrl(p) + hash);
    document.title = p.split('/').pop() + ' — Markdown Viewer';
    renderCrumbs();
    highlightActive();

    await render(state.source);
    if (keepScroll) contentEl.scrollTop = scroll;
    else if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
    else contentEl.scrollTop = 0;
  }

  function renderCrumbs() {
    const parts = state.current.split('/');
    const file = parts.pop();
    $('#crumbs').innerHTML = '';
    $('#crumbs').append(
      [state.rootName, ...parts].join(' / ') + ' / ',
      Object.assign(document.createElement('b'), { textContent: file }),
    );
    $('#crumbs').title = state.current;
  }

  // -------------------------------------------------------------- tree
  function buildTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.p.split('/');
      const name = parts.pop();
      let node = root;
      for (const d of parts) {
        if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
        node = node.dirs.get(d);
      }
      node.files.push({ name, p: f.p });
    }
    return root;
  }

  function fileLink(p, labelNodes) {
    const a = document.createElement('a');
    a.href = viewUrl(p);
    a.dataset.p = p;
    a.title = p;
    a.append(...labelNodes);
    return a;
  }

  function renderTreeNode(node, prefix) {
    const frag = document.createDocumentFragment();
    const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, child] of dirs) {
      const d = document.createElement('details');
      d.dataset.dir = prefix + name;
      const s = document.createElement('summary');
      s.textContent = name;
      d.appendChild(s);
      const kids = document.createElement('div');
      kids.className = 'children';
      d.appendChild(kids);
      // render children lazily on first open
      let filled = false;
      const fill = () => { if (!filled) { kids.appendChild(renderTreeNode(child, prefix + name + '/')); filled = true; } };
      d.addEventListener('toggle', () => d.open && fill());
      d._fill = fill;
      frag.appendChild(d);
    }
    for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      frag.appendChild(fileLink(f.p, [f.name]));
    }
    return frag;
  }

  function highlightText(text, terms) {
    if (!terms.length) return [text];
    const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return text.split(re).map((part, i) => (i % 2 ? Object.assign(document.createElement('mark'), { textContent: part }) : part));
  }

  function renderSidebar() {
    const q = filterEl.value.trim().toLowerCase();
    treeEl.innerHTML = '';
    if (!q) {
      $('#count').textContent = `${state.files.length} files`;
      treeEl.appendChild(renderTreeNode(buildTree(state.files), ''));
      highlightActive(true);
      return;
    }
    const terms = q.split(/\s+/);
    const matches = state.files.filter((f) => terms.every((t) => f.p.toLowerCase().includes(t)));
    $('#count').textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'}`;
    const list = document.createElement('div');
    list.className = 'flat';
    for (const f of matches.slice(0, 400)) {
      const parts = f.p.split('/');
      const name = parts.pop();
      const dir = Object.assign(document.createElement('span'), { className: 'dir' });
      dir.append(...highlightText(parts.join('/') || '.', terms));
      list.appendChild(fileLink(f.p, [...highlightText(name, terms), dir]));
    }
    treeEl.appendChild(list);
    highlightActive();
  }

  function highlightActive(expand = false) {
    $$('#tree a.active').forEach((a) => a.classList.remove('active'));
    if (!state.current) return;
    if (expand && !filterEl.value.trim()) {
      // open each ancestor folder so the active file is visible
      const parts = state.current.split('/').slice(0, -1);
      let prefix = '';
      for (const part of parts) {
        prefix += part;
        const d = $$('#tree details').find((el) => el.dataset.dir === prefix);
        if (!d) break;
        d._fill();
        d.open = true;
        prefix += '/';
      }
    }
    const a = $$('#tree a').find((el) => el.dataset.p === state.current);
    if (a) { a.classList.add('active'); if (expand) a.scrollIntoView({ block: 'center' }); }
  }

  async function loadFiles() {
    const data = await (await fetch('/api/files')).json();
    state.files = data.files;
    state.fileSet = new Set(data.files.map((f) => f.p));
    state.rootName = data.rootName;
    $('#rootName').textContent = data.rootName;
    $('#rootName').title = data.root;
    renderSidebar();
  }

  // ------------------------------------------------------------ events
  treeEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-p]');
    if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    openFile(a.dataset.p);
  });

  contentEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-internal]');
    if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    openFile(a.dataset.internal, { hash: new URL(a.href).hash });
  });

  let filterTimer;
  filterEl.addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(renderSidebar, 80); });
  filterEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const a = $('#tree a'); if (a) openFile(a.dataset.p); }
    if (e.key === 'Escape') { filterEl.value = ''; renderSidebar(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== filterEl) { e.preventDefault(); filterEl.focus(); filterEl.select(); }
  });

  $('#rescanBtn').addEventListener('click', async () => {
    await fetch('/api/rescan', { method: 'POST' });
    await loadFiles();
    toast(`Rescanned: ${state.files.length} files`);
  });

  $('#copyDocBtn').addEventListener('click', () => {
    if (!state.current) return;
    const ready = waitForDiagrams(contentEl).then(() => exportNodes([...contentEl.children]));
    writeClipboard({ 'text/html': ready.then((r) => r.html), 'text/plain': ready.then((r) => r.text) }, 'document for Docs');
  });
  $('#copyMdBtn').addEventListener('click', () => state.current && writeClipboard({ 'text/plain': state.source }, 'markdown'));
  $('#copyTextBtn').addEventListener('click', () => {
    if (!state.current) return;
    writeClipboard({ 'text/plain': exportNodes([...contentEl.children]).text }, 'plain text');
  });
  $('#printBtn').addEventListener('click', () => window.print());

  // theme switch: auto → light → dark
  const THEMES = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
  const themeBtn = $('#themeBtn');
  let themePref = 'auto';
  try { themePref = localStorage.getItem('md-viewer-theme') || 'auto'; } catch { /* storage blocked */ }
  if (!THEMES[themePref]) themePref = 'auto';
  themeBtn.textContent = THEMES[themePref];
  themeBtn.addEventListener('click', () => {
    const order = Object.keys(THEMES);
    themePref = order[(order.indexOf(themePref) + 1) % order.length];
    try { localStorage.setItem('md-viewer-theme', themePref); } catch { /* storage blocked */ }
    themeBtn.textContent = THEMES[themePref];
    window.applyTheme(themePref);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => themePref === 'auto' && window.applyTheme('auto'));

  // Ordinary Cmd/Ctrl+C on a selection: also produce docs-friendly HTML
  // (inline styles, diagrams as PNG images).
  document.addEventListener('copy', (e) => {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.commonAncestorContainer)) return;
    const frag = range.cloneContents();
    const div = document.createElement('div');
    div.appendChild(frag);
    if (!div.querySelector('*')) return; // plain text only: let the browser handle it
    // A drag across table cells yields bare rows/cells; rebuild the table
    // around them so it pastes as a table, not loose text.
    const ancestor = range.commonAncestorContainer;
    const tag = ancestor.nodeType === 1 ? ancestor.tagName : '';
    if (/^(TABLE|THEAD|TBODY|TFOOT|TR)$/.test(tag)) {
      const table = document.createElement('table');
      if (tag === 'TABLE') table.append(...div.childNodes);
      else {
        const body = document.createElement('tbody');
        if (tag === 'TR') body.appendChild(document.createElement('tr')).append(...div.childNodes);
        else body.append(...div.childNodes);
        table.appendChild(body);
      }
      div.replaceChildren(table);
    }
    const { html, text } = docsPayload(div);
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  });

  window.addEventListener('popstate', () => {
    const p = pathFromLocation();
    if (p && p !== state.current) openFile(p, { push: false, hash: location.hash });
  });

  function pathFromLocation() {
    if (!location.pathname.startsWith('/view/')) return null;
    return location.pathname.slice('/view/'.length).split('/').map(decodeURIComponent).join('/');
  }

  // live reload
  const es = new EventSource('/api/events');
  es.addEventListener('changed', (e) => {
    const { p } = JSON.parse(e.data);
    if (p === state.current) openFile(p, { push: false, keepScroll: true });
  });
  es.addEventListener('tree', () => loadFiles());

  // ------------------------------------------------------------- boot
  loadFiles().then(() => {
    const p = pathFromLocation();
    if (p && state.fileSet.has(p)) return openFile(p, { push: false, hash: location.hash });
    const readme = state.files.find((f) => /^readme\.md$/i.test(f.p)) || state.files.find((f) => /(^|\/)readme\.md$/i.test(f.p));
    if (readme) openFile(readme.p, { push: false });
  });
})();

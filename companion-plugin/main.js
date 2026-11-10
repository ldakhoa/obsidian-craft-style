'use strict';

const { MarkdownRenderChild, Plugin } = require('obsidian');
const { Decoration, ViewPlugin } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');
const { syntaxTree } = require('@codemirror/language');

const LENS_ID = 'craft-lens-refract';
const LENS_BAND = 8;
const LENS_SCALE = 14;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Boundaries come from the editor's own parse, so the numbers always agree with what it styles
// as code. Only the fences are read, because a blank line inside a block has no token of its own.
function findCodeBlocks(state) {
  const { doc } = state;
  const blocks = [];
  let start = null;
  syntaxTree(state).iterate({
    enter({ name, from }) {
      if (start === null && name.includes('HyperMD-codeblock-begin')) {
        start = doc.lineAt(from).number + 1;
      } else if (start !== null && name.includes('HyperMD-codeblock-end')) {
        blocks.push({ start, end: doc.lineAt(from).number - 1 });
        start = null;
      }
    },
  });
  if (start !== null) blocks.push({ start, end: doc.lines });
  return blocks;
}

const editorLineNumbers = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.blocks = findCodeBlocks(view.state);
      this.decorations = this.build(view);
    }

    update(update) {
      const reparsed = syntaxTree(update.state) !== syntaxTree(update.startState);
      if (reparsed) this.blocks = findCodeBlocks(update.state);
      if (reparsed || update.viewportChanged) this.decorations = this.build(update.view);
    }

    build(view) {
      const builder = new RangeSetBuilder();
      const { doc } = view.state;
      const firstVisible = doc.lineAt(view.viewport.from).number;
      const lastVisible = doc.lineAt(view.viewport.to).number;

      for (const block of this.blocks) {
        // The fence lines sit outside the numbered range but share the gutter's width.
        const from = Math.max(block.start - 1, firstVisible, 1);
        const to = Math.min(block.end + 1, lastVisible, doc.lines);
        const digits = String(block.end - block.start + 1).length;
        for (let n = from; n <= to; n++) {
          const attributes = { style: `--craft-code-digits: ${digits}` };
          if (n >= block.start && n <= block.end) {
            attributes['data-craft-ln'] = String(n - block.start + 1);
          }
          const { from: pos } = doc.line(n);
          builder.add(pos, pos, Decoration.line({ attributes }));
        }
      }
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

// An inward vector field in the red and green channels, strongest at the pill's rim.
function lensMap(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  const radius = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - width / 2;
      const dy = y + 0.5 - height / 2;
      const qx = Math.max(Math.abs(dx) - (width / 2 - radius), 0);
      const qy = Math.abs(dy);
      const distance = Math.hypot(qx, qy) || 1;
      const depth = radius - distance;
      const strength = depth >= LENS_BAND ? 0 : Math.pow(1 - Math.max(depth, 0) / LENS_BAND, 2);
      const index = (y * width + x) * 4;
      image.data[index] = Math.round(128 - 127 * Math.sign(dx) * (qx / distance) * strength);
      image.data[index + 1] = Math.round(128 - 127 * Math.sign(dy) * (qy / distance) * strength);
      image.data[index + 2] = 128;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

// Craft draws every document as the same page glyph: a short title stroke over eight lines.
function pageGlyph() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 28 36');
  svg.setAttribute('aria-hidden', 'true');
  const bar = (cls, y, width) => {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', cls);
    for (const [name, value] of Object.entries({ x: 4, y, width, height: 1.5, rx: 0.75 })) {
      rect.setAttribute(name, String(value));
    }
    return rect;
  };
  svg.append(bar('craft-doc-thumb-title', 6, 10));
  for (let i = 0; i < 8; i++) svg.append(bar('craft-doc-thumb-line', 9.5 + i * 2.5, 20));
  return svg;
}

module.exports = class CraftStyleCompanion extends Plugin {
  async onload() {
    this.registerEditorExtension(editorLineNumbers);

    this.codeSizes = new WeakMap();
    this.codeObserver = new ResizeObserver((entries) => {
      // Reading view detaches off-screen sections and reattaches them, so they stay observed.
      for (const { target } of entries) {
        if (target.isConnected) this.layoutCode(target);
      }
    });
    this.registerMarkdownPostProcessor((el, ctx) => this.decorateCode(el, ctx));

    this.app.workspace.onLayoutReady(() => {
      this.installLens();
      this.refreshDocHeader();

      const { workspace, vault } = this.app;
      const refresh = () => this.refreshDocHeader();
      const updateLens = () => this.updateLens();
      this.registerEvent(workspace.on('file-open', refresh));
      this.registerEvent(workspace.on('active-leaf-change', refresh));
      this.registerEvent(workspace.on('layout-change', refresh));
      this.registerEvent(workspace.on('layout-change', updateLens));
      this.registerEvent(workspace.on('resize', updateLens));
      this.registerEvent(vault.on('modify', refresh));
      this.registerEvent(vault.on('rename', refresh));
      this.registerInterval(window.setInterval(refresh, 60 * 1000));
    });
  }

  onunload() {
    this.codeObserver.disconnect();
    document.querySelectorAll('.markdown-rendered pre').forEach((pre) => {
      pre.querySelector(':scope > .craft-code-gutter')?.remove();
      pre.style.removeProperty('--craft-code-digits');
    });
    this.removeDocHeader();
    this.lens?.svg.remove();
    document.body.style.removeProperty('--craft-lens-backdrop');
  }

  decorateCode(el, ctx) {
    el.querySelectorAll('pre > code').forEach((code) => {
      const pre = code.parentElement;
      if (pre.querySelector(':scope > .craft-code-gutter')) return;
      pre.createDiv({ cls: 'craft-code-gutter', attr: { 'aria-hidden': 'true' } });
      this.codeObserver.observe(pre);

      const lifetime = new MarkdownRenderChild(pre);
      lifetime.onunload = () => this.codeObserver.unobserve(pre);
      ctx.addChild(lifetime);
    });
  }

  // Placed by measurement because long lines wrap, which puts each number at its own height.
  layoutCode(pre) {
    const code = pre.querySelector(':scope > code');
    const gutter = pre.querySelector(':scope > .craft-code-gutter');
    const size = `${pre.clientWidth}x${pre.clientHeight}`;
    if (!code || !gutter || !pre.clientWidth || this.codeSizes.get(pre) === size) return;
    this.codeSizes.set(pre, size);

    const lineHeight = parseFloat(getComputedStyle(code).lineHeight);
    const text = code.textContent.replace(/\n$/, '');
    pre.style.setProperty('--craft-code-digits', String(text.split('\n').length).length);

    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const preTop = pre.getBoundingClientRect().top + pre.clientTop;
    const range = document.createRange();
    const numbers = document.createDocumentFragment();
    let node = walker.nextNode();
    let nodeStart = 0;
    let lineStart = 0;

    for (let number = 1; lineStart <= text.length; number++) {
      while (node && lineStart >= nodeStart + node.length) {
        nodeStart += node.length;
        node = walker.nextNode();
      }
      if (!node) break;

      // The first character of an empty line is its own newline, which still has a box on that row.
      const offset = lineStart - nodeStart;
      range.setStart(node, offset);
      range.setEnd(node, Math.min(offset + 1, node.length));
      const rect = range.getClientRects()[0];
      if (rect) {
        const label = document.createElement('div');
        label.className = 'craft-code-ln';
        label.dataset.n = number;
        label.style.top = `${rect.top - preTop + (rect.height - lineHeight) / 2}px`;
        numbers.append(label);
      }

      const newline = text.indexOf('\n', lineStart);
      if (newline === -1) break;
      lineStart = newline + 1;
    }
    gutter.replaceChildren(numbers);
  }

  installLens() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0';

    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.id = LENS_ID;
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');

    const image = document.createElementNS(SVG_NS, 'feImage');
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttribute('result', 'map');

    const displacement = document.createElementNS(SVG_NS, 'feDisplacementMap');
    displacement.setAttribute('in', 'SourceGraphic');
    displacement.setAttribute('in2', 'map');
    displacement.setAttribute('scale', String(LENS_SCALE));
    displacement.setAttribute('xChannelSelector', 'R');
    displacement.setAttribute('yChannelSelector', 'G');

    filter.append(image, displacement);
    svg.append(filter);
    document.body.append(svg);
    this.lens = { svg, filter, image, width: 0, height: 0 };
    this.updateLens();
    document.body.style.setProperty('--craft-lens-backdrop', `url(#${LENS_ID}) saturate(1.4) brightness(1.03)`);
  }

  // The map has to match the thumb's size, which follows the sidebar width and tab count.
  updateLens() {
    if (!this.lens) return;
    const tab = document.querySelector('.mod-left-split .workspace-tab-header-container-inner > .workspace-tab-header.is-active');
    if (!tab) return;
    const width = Math.round(tab.offsetWidth);
    const height = Math.round(tab.offsetHeight);
    if (!width || !height || (width === this.lens.width && height === this.lens.height)) return;

    const { filter, image } = this.lens;
    for (const element of [filter, image]) {
      element.setAttribute('width', String(width));
      element.setAttribute('height', String(height));
    }
    image.setAttribute('href', lensMap(width, height));
    this.lens.width = width;
    this.lens.height = height;
  }

  refreshDocHeader() {
    const host = document.querySelector('.mod-left-split .workspace-tabs.mod-top .workspace-tab-header-container');
    const file = this.app.workspace.getActiveFile();
    if (!host || !file) {
      this.removeDocHeader();
      return;
    }

    if (this.header?.host !== host) {
      this.removeDocHeader();
      const root = createDiv({ cls: 'craft-doc-header' });
      root.createDiv({ cls: 'craft-doc-thumb' }).append(pageGlyph());
      const text = root.createDiv({ cls: 'craft-doc-text' });
      const title = text.createDiv({ cls: 'craft-doc-title' });
      const subtitle = text.createDiv({ cls: 'craft-doc-subtitle' });
      host.prepend(root);
      host.addClass('craft-has-doc-header');
      this.header = { host, root, title, subtitle };
    }

    this.header.title.setText(file.basename);
    this.header.subtitle.setText(window.moment(file.stat.mtime).fromNow());
  }

  removeDocHeader() {
    if (!this.header) return;
    this.header.root.remove();
    this.header.host.removeClass('craft-has-doc-header');
    this.header = null;
  }
};

import type { Page } from 'playwright';
import { measureContentLeft } from './layout';

const TREE_WIDTH = 240;

export async function paintFileBrowserPanel(page: Page): Promise<void> {
  const contentLeft = await measureContentLeft(page);
  await page.evaluate(({ left, treeWidth }) => {
    const old = document.getElementById('__cinema_filebrowser');
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = '__cinema_filebrowser';
    panel.style.cssText = `
      position:fixed;left:${left}px;top:54px;width:${treeWidth}px;bottom:0;z-index:55;pointer-events:none;
      background:#050507;
      border-right:1px solid #1c1c20;
      overflow:hidden;
      font-family:'SFMono-Regular',Menlo,Monaco,monospace;
      font-size:12px;color:#8b949e;
      animation:cinema-fade-in 300ms ease both;
    `;

    type FileNode = { name: string; type: 'dir' | 'file'; ext?: string; children?: FileNode[]; open?: boolean };

    const EXT_COLOR: Record<string, string> = {
      ts: '#3b82f6', tsx: '#61dafb', js: '#f0c674', json: '#fbbf24',
      css: '#a78bfa', md: '#8b949e', yaml: '#10b981', yml: '#10b981',
      test: '#f97316', spec: '#f97316',
    };
    const FILE_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
    const FOLDER_OPEN_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    const CHEVRON_DOWN = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;
    const CHEVRON_RIGHT = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>`;

    const tree: FileNode[] = [
      {
        name: 'src', type: 'dir', open: true, children: [
          {
            name: 'auth', type: 'dir', open: true, children: [
              { name: 'index.ts', type: 'file', ext: 'ts' },
              { name: 'rotate.ts', type: 'file', ext: 'ts' },
              { name: 'types.ts', type: 'file', ext: 'ts' },
              {
                name: '__tests__', type: 'dir', open: true, children: [
                  { name: 'rotate.test.ts', type: 'file', ext: 'test' },
                ],
              },
            ],
          },
          {
            name: 'render', type: 'dir', open: false, children: [
              { name: 'layout.ts', type: 'file', ext: 'ts' },
              { name: 'pipeline.ts', type: 'file', ext: 'ts' },
            ],
          },
          { name: 'index.ts', type: 'file', ext: 'ts' },
          { name: 'config.ts', type: 'file', ext: 'ts' },
        ],
      },
      {
        name: 'docs', type: 'dir', open: false, children: [
          { name: 'openapi.yaml', type: 'file', ext: 'yaml' },
        ],
      },
      { name: 'package.json', type: 'file', ext: 'json' },
      { name: 'tsconfig.json', type: 'file', ext: 'json' },
    ];

    function renderNode(node: FileNode, depth: number, highlighted = false): string {
      const indent = depth * 16 + 8;
      const color = node.type === 'file' ? (EXT_COLOR[node.ext ?? ''] ?? '#8b949e') : '#fbbf24';
      const bg = highlighted ? 'background:#0d1117;border-left:2px solid #58a6ff;' : 'border-left:2px solid transparent;';
      const nameColor = highlighted ? '#e6edf3' : node.type === 'file' ? '#c9d1d9' : '#e6edf3';

      if (node.type === 'dir') {
        const chevron = node.open ? CHEVRON_DOWN : CHEVRON_RIGHT;
        let html = `
          <div style="display:flex;align-items:center;gap:5px;padding:3px 8px 3px ${indent}px;${bg}">
            <span style="color:#6b7280;display:inline-flex;">${chevron}</span>
            <span style="color:${color};display:inline-flex;">${FOLDER_OPEN_ICON}</span>
            <span style="color:${nameColor};font-size:12px;">${node.name}</span>
          </div>`;
        if (node.open && node.children) {
          for (const child of node.children) {
            html += renderNode(child, depth + 1, child.name === 'rotate.ts');
          }
        }
        return html;
      }

      return `
        <div data-file="${node.name}" style="display:flex;align-items:center;gap:5px;padding:3px 8px 3px ${indent}px;${bg}cursor:default;">
          <span style="color:${color};display:inline-flex;">${FILE_ICON}</span>
          <span style="color:${nameColor};font-size:12px;">${node.name}</span>
        </div>`;
    }

    const header = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px 8px;border-bottom:1px solid #1c1c20;">
        <div style="display:flex;align-items:center;gap:6px;color:#e6edf3;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Files</span>
        </div>
        <span style="font-size:10px;color:#484d56;font-family:'Inter',sans-serif;">refactor-auth-flow</span>
      </div>`;

    let treeHtml = '';
    for (const node of tree) treeHtml += renderNode(node, 0);

    panel.innerHTML = header + `<div style="overflow:hidden;flex:1;">${treeHtml}</div>`;
    document.body.appendChild(panel);
  }, { left: contentLeft, treeWidth: TREE_WIDTH });
}

export async function paintFileBrowserFileOpen(page: Page): Promise<void> {
  const contentLeft = await measureContentLeft(page);
  await page.evaluate((left) => {
    const old = document.getElementById('__cinema_fileview');
    if (old) old.remove();

    const view = document.createElement('div');
    view.id = '__cinema_fileview';
    view.style.cssText = `
      position:fixed;left:${left}px;right:760px;top:54px;bottom:0;z-index:56;pointer-events:none;
      background:#0d1117;
      border-right:1px solid #1c1c20;
      overflow:hidden;
      font-family:'SFMono-Regular',Menlo,Monaco,monospace;
      font-size:12.5px;line-height:1.6;
      animation:cinema-fade-in 280ms ease both;
    `;

    const TAB = `
      <div style="display:flex;align-items:center;gap:6px;padding:8px 14px;border-bottom:1px solid #1c1c20;background:#0d1117;border-right:1px solid #1c1c20;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.5"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
        <span style="font-size:12px;color:#e6edf3;">rotate.ts</span>
        <span style="margin-left:4px;font-size:10px;color:#484d56;">src/auth/</span>
      </div>`;

    const lines: Array<[number, string, string]> = [
      [1, '#6b7280', `import { Token } from './types';`],
      [2, '#6b7280', `import { TokenStore } from './store';`],
      [3, '#6b7280', ``],
      [4, '#6b7280', `export class TokenRotator {`],
      [5, '#6b7280', `  private store: TokenStore;`],
      [6, '#6b7280', ``],
      [7, '#6b7280', `  constructor(store: TokenStore) {`],
      [8, '#6b7280', `    this.store = store;`],
      [9, '#6b7280', `  }`],
      [10, '#6b7280', ``],
      [11, '#58a6ff', `  async rotate(prev?: Token): Promise<Token> {`],
      [12, '#58a6ff', `    if (prev && !prev.isExpired()) return prev;`],
      [13, '#58a6ff', `    const next = await this.mint();`],
      [14, '#58a6ff', `    await this.store.replace(prev, next);`],
      [15, '#58a6ff', `    return next;`],
      [16, '#58a6ff', `  }`],
      [17, '#6b7280', ``],
      [18, '#6b7280', `  private async mint(): Promise<Token> {`],
      [19, '#6b7280', `    return {`],
      [20, '#6b7280', `      id: crypto.randomUUID(),`],
      [21, '#6b7280', `      createdAt: Date.now(),`],
      [22, '#6b7280', `      expiresAt: Date.now() + 3_600_000,`],
      [23, '#6b7280', `      isExpired() { return Date.now() > this.expiresAt; },`],
      [24, '#6b7280', `    };`],
      [25, '#6b7280', `  }`],
      [26, '#6b7280', `}`],
    ];

    const linesHtml = lines.map(([n, col, text]) => `
      <div style="display:flex;min-height:20px;">
        <span style="display:inline-block;width:36px;text-align:right;padding-right:14px;color:#484d56;user-select:none;flex-shrink:0;">${n}</span>
        <span style="color:${col};white-space:pre;">${String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
      </div>`).join('');

    view.innerHTML = TAB + `<div style="padding:12px 0;">${linesHtml}</div>`;
    document.body.appendChild(view);
  }, contentLeft + TREE_WIDTH);
}

export async function hideFileBrowserPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('__cinema_filebrowser')?.remove();
    document.getElementById('__cinema_fileview')?.remove();
  });
}

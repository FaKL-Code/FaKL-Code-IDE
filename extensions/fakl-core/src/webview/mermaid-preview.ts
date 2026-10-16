import mermaid from 'mermaid';

/*
 * Diagramas Mermaid no preview de Markdown da IDE (RF-404), como no Obsidian:
 * blocos ```mermaid viram SVG. O preview troca o conteúdo a cada edição e
 * avisa com o evento `vscode.markdown.updateContent`.
 */

let rendering = Promise.resolve();
let counter = 0;

function theme(): 'dark' | 'default' {
  const classes = document.body.classList;
  return classes.contains('vscode-dark') || classes.contains('vscode-high-contrast')
    ? 'dark'
    : 'default';
}

async function render(): Promise<void> {
  const blocks = [
    ...document.querySelectorAll<HTMLElement>('pre > code.language-mermaid, pre.language-mermaid'),
  ];
  if (blocks.length === 0) return;
  mermaid.initialize({ startOnLoad: false, theme: theme(), securityLevel: 'strict' });
  for (const code of blocks) {
    const pre = code.tagName === 'PRE' ? code : (code.parentElement ?? code);
    const source = code.textContent;
    const host = document.createElement('div');
    host.className = 'fakl-mermaid';
    try {
      const { svg } = await mermaid.render(`fakl-mermaid-${String(counter++)}`, source);
      host.innerHTML = svg;
    } catch (error) {
      host.className = 'fakl-mermaid fakl-mermaid-erro';
      host.textContent = `Mermaid: ${error instanceof Error ? error.message : String(error)}`;
    }
    pre.replaceWith(host);
  }
}

function schedule(): void {
  rendering = rendering.then(render, render);
}

window.addEventListener('vscode.markdown.updateContent', schedule);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', schedule);
} else {
  schedule();
}

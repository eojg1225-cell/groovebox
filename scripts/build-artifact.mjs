// Packs dist/ into a claude.ai Artifact: one page with inlined CSS/JS (the host wraps it in
// its own <html>/<head>/<body>), plus the worklet script as a file served next to the page.
// Run after `vite build`. Output: dist-artifact/
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';

const assets = readdirSync('dist/assets');
const pick = (re) => assets.find((f) => re.test(f));
const css = readFileSync(`dist/assets/${pick(/^index-.*\.css$/)}`, 'utf8');
const worklet = pick(/^processor-.*\.js$/);
// The worklet is published under a stable name so republishing replaces it.
const WORKLET_NAME = 'groovebox-worklet.js';
const js = readFileSync(`dist/assets/${pick(/^index-.*\.js$/)}`, 'utf8')
  .split(worklet).join(WORKLET_NAME)
  .replace(/<\/script/gi, '<\\/script');

const html = readFileSync('dist/index.html', 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).trim();

const page = `<title>GrooveAccess</title>
<meta name="theme-color" content="#111417">
<style>
:root { color-scheme: dark; }
${css}
</style>
${body}
<script type="module">
${js}
</script>
`;

rmSync('dist-artifact', { recursive: true, force: true });
mkdirSync('dist-artifact');
writeFileSync('dist-artifact/groovebox.html', page);
// The inlined bundle resolves the worklet relative to the page, so it sits beside it.
copyFileSync(`dist/assets/${worklet}`, `dist-artifact/${WORKLET_NAME}`);
console.log(`dist-artifact/groovebox.html (+ ${WORKLET_NAME})`);

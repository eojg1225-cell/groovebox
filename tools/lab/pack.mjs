// Packs dist-lab into one Artifact page (inlined CSS/JS) plus the worklet beside it.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';

const dir = 'dist-lab';
const assets = readdirSync(`${dir}/assets`);
const pick = (re) => assets.find((f) => re.test(f));
const css = readFileSync(`${dir}/assets/${pick(/\.css$/)}`, 'utf8');
const worklet = pick(/^worklet-.*\.js$/);
const NAME = 'lab-worklet.js';
const js = readFileSync(`${dir}/assets/${pick(/^index-.*\.js$/)}`, 'utf8').split(worklet).join(NAME).replace(/<\/script/gi, '<\\/script');
const html = readFileSync(`${dir}/index.html`, 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '').trim();
const page = `<meta charset="utf-8">
<title>GrooveAccess Sound Lab</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600&family=Atkinson+Hyperlegible:wght@400;700&display=swap">
<style>
${css}
</style>
${body}
<script type="module">
${js}
</script>
`;
rmSync('dist-lab-artifact', { recursive: true, force: true });
mkdirSync('dist-lab-artifact');
writeFileSync('dist-lab-artifact/lab.html', page);
copyFileSync(`${dir}/assets/${worklet}`, `dist-lab-artifact/${NAME}`);
console.log(`dist-lab-artifact/lab.html (+ ${NAME})`);

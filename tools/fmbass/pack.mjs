// Packs dist-fmbass into one Artifact page (inlined CSS/JS) plus the worklet beside it.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';

const dir = 'dist-fmbass';
const assets = readdirSync(`${dir}/assets`);
const pick = (re) => assets.find((f) => re.test(f));
const css = readFileSync(`${dir}/assets/${pick(/\.css$/)}`, 'utf8');
const worklet = pick(/^worklet-.*\.js$/);
const NAME = 'fmbass-worklet.js';
const js = readFileSync(`${dir}/assets/${pick(/^index-.*\.js$/)}`, 'utf8').split(worklet).join(NAME).replace(/<\/script/gi, '<\\/script');
const html = readFileSync(`${dir}/index.html`, 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '').trim();
const page = `<title>FM Bass Ratios</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@500;700&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@500&display=swap">
<style>
${css}
</style>
${body}
<script type="module">
${js}
</script>
`;
rmSync('dist-fmbass-artifact', { recursive: true, force: true });
mkdirSync('dist-fmbass-artifact');
writeFileSync('dist-fmbass-artifact/fmbass.html', page);
copyFileSync(`${dir}/assets/${worklet}`, `dist-fmbass-artifact/${NAME}`);
console.log(`dist-fmbass-artifact/fmbass.html (+ ${NAME})`);

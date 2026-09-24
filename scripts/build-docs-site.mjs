import fs from 'node:fs';
import path from 'node:path';

const template = fs.readFileSync('docs-site/template.html', 'utf8');
const source = fs.readFileSync('docs-site/body.html', 'utf8');
const at = (marker) => {
  const index = source.indexOf(marker);
  if (index < 0 || source.indexOf(marker, index + 1) >= 0) throw new Error(`Expected one docs section: ${marker}`);
  return index;
};
const helpStart = at('<h2 id="help">');
const installStart = at('<h2 id="installation">');
const legalStart = at('<h2 id="terms-of-use">');
const legalEnd = at('<p>Confirm each dependency:</p>');
if (!(helpStart < installStart && installStart < legalStart && legalStart < legalEnd)) {
  throw new Error('The help, installation, and legal source sections changed order');
}

const prefix = source.slice(0, helpStart);
const warningStart = prefix.indexOf('<blockquote>');
const warningEnd = prefix.indexOf('</blockquote>', warningStart);
if (warningStart < 0 || warningEnd < 0) throw new Error('Community Preview warning is missing');
const help = prefix.slice(warningStart, warningEnd + '</blockquote>'.length) + '\n' + source.slice(helpStart, installStart);
const installation = source.slice(0, helpStart) + source.slice(installStart, legalStart) + source.slice(legalEnd);
const legal = source.slice(legalStart, legalEnd);
const home = `<nav class="topic-index" aria-label="Documentation sections">
  <a href="install/">Installation guide<span>Server setup, deployment shapes, operations, and troubleshooting</span></a>
  <a href="install/#configuration">Configuration options<span>Domain, ports, database, images, and optional services</span></a>
  <a href="legal/">Legal notices<span>Terms, privacy, cookies, and licences on their own page</span></a>
</nav>\n${help}`;

function sectionIds(content) {
  const used = new Set([...content.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  return content.replace(/<h([23])(?![^>]*\bid=)([^>]*)>([\s\S]*?)<\/h\1>/g, (_full, level, attrs, title) => {
    const base = title.replace(/<[^>]*>/g, '').replace(/^\d+(?:\.\d+)*\.?\s*/, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!base) throw new Error(`Heading lacks a usable anchor: ${title}`);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return `<h${level} id="${id}"${attrs}>${title}</h${level}>`;
  });
}

const redirectOldLinks = `<script>
  (() => {
    const hash = location.hash.slice(1);
    if (['terms-of-use', 'privacy-notice', 'cookie-notice', 'software-and-paid-feature-licences'].includes(hash)) {
      location.replace('legal/' + location.hash);
    } else if (['installation', 'configuration', 'troubleshooting'].includes(hash)) {
      location.replace('install/' + location.hash);
    }
  })();
</script>`;

function render({ content, root, title, description, hero, intro, canonicalPath, legacyRedirect = '' }) {
  const body = sectionIds(content);
  const headings = [...body.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g)];
  const toc = headings.map(([, level, id, text]) => `<a class="level-${level}" href="#${id}">${text.replace(/<[^>]+>/g, '')}</a>`).join('\n');
  return template
    .replace('<!--TOC-->', toc)
    .replace('<!--TOC_MOBILE-->', toc)
    .replace('<!--CONTENT-->', body)
    .replace('<!--PAGE_TITLE-->', title)
    .replace('<!--PAGE_DESCRIPTION-->', description)
    .replace('<!--CANONICAL_PATH-->', canonicalPath)
    .replace('<!--HERO_TITLE-->', hero)
    .replace('<!--HERO_DESCRIPTION-->', intro)
    .replace('  <!--LEGACY_REDIRECT-->\n', legacyRedirect ? `  ${legacyRedirect}\n` : '')
    .replaceAll('<!--ROOT-->', root);
}

const pages = [
  ['index.html', render({ content: home, root: '', title: 'Help', description: 'Josi CE help and links to installation and legal guides.', hero: 'Josi CE Help', intro: 'Choose a guide, or browse help for the current features.', canonicalPath: '', legacyRedirect: redirectOldLinks })],
  ['install/index.html', render({ content: installation, root: '../', title: 'Installation and operations', description: 'Josi CE installation choices, configuration, operations, and troubleshooting.', hero: 'Installation and operations', intro: 'The complete operator guide, indexed by chapter.', canonicalPath: 'install/' })],
  ['legal/index.html', render({ content: legal, root: '../', title: 'Legal notices', description: 'Josi CE terms of use, privacy notice, cookie notice, and licences.', hero: 'Legal notices', intro: 'Terms, privacy, cookies, and licences in one separate legal section.', canonicalPath: 'legal/' })],
];
for (const [filename, html] of pages) {
  const output = path.join('docs-site/public', filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, html);
}
const plain = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&(?:quot|#39|amp|lt|gt);/g, (entity) => ({
  '&quot;': '"', '&#39;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>',
})[entity]).replace(/\s+/g, ' ').trim();
const helpIndex = pages.flatMap(([filename, html]) => {
  const article = html.match(/<article>([\s\S]*?)<\/article>/)?.[1] ?? '';
  const headings = [...article.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g)];
  const pathname = filename === 'index.html' ? '' : filename.replace('index.html', '');
  return headings.map((heading, i) => ({
    title: plain(heading[3]),
    url: `https://help.heyjosi.com/${pathname}#${heading[2]}`,
    text: plain(article.slice(heading.index + heading[0].length, headings[i + 1]?.index ?? article.length)).slice(0, 2200),
  }));
});
fs.mkdirSync('docs-site/netlify/functions', { recursive: true });
fs.writeFileSync('docs-site/netlify/functions/help-index.json', JSON.stringify(helpIndex));
fs.mkdirSync('docs-site/public/brand', { recursive: true });
fs.copyFileSync('docs-site/brand/josi-mark.png', 'docs-site/public/brand/josi-mark.png');
fs.writeFileSync('docs-site/index.html', pages[0][1]);

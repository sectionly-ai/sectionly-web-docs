#!/usr/bin/env node
/**
 * 从 sectionly.ai 官网 Payload CMS 的公开 REST API 导出已发布文档，转换为 Mintlify MDX。
 *
 * ⚠️ 一次性迁移工具：迁移完成后文档直接在本仓库编辑，重新运行会用 Payload 旧内容
 * 覆盖手工修改。确需重跑时显式加 --force：
 *   node scripts/export-payload.mjs --force
 *
 * - 只导出 en / zh（Payload 里也只有这两种语言）。
 * - 正文只做语法转换：Fumadocs 组件 → Mintlify 组件、图片本地化，不改写内容。
 * - 生成 scripts/navigation.generated.json 与 scripts/redirects-map.json（旧 /docs/<slug> → 新路径）。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--force')) {
  console.error(
    'One-time migration tool. Docs are edited in this repo; re-running overwrites them with Payload content. Pass --force if you really mean it.'
  );
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.sectionly.ai';
const API = `${SITE}/payload/api/docs?limit=500&depth=1&where%5B_status%5D%5Bequals%5D=published`;
const LOCALES = ['en', 'zh'];

/**
 * 信息架构：每个 App 一个顶部 Tab，便于以后接入 B2B / Reviews / Upsell 等其他应用文档。
 * 页面顺序以线上英文侧栏为准（中文版在 Payload 里没设 order，线上顺序是乱的）。
 */
const TABS = [
  {
    tab: { en: 'Product Options', zh: 'Product Options' },
    icon: 'sliders-horizontal',
    groups: [
      {
        name: { en: 'Custom Product Option', zh: '自定义产品选项' },
        icon: 'settings',
        slugs: [
          'option/getting-started',
          'option/create-option-ai',
          'option/create-option-template',
          'option/create-option-manually',
        ],
      },
    ],
  },
];

const KNOWN = new Set(TABS.flatMap((t) => t.groups.flatMap((g) => g.slugs)));
const pagePath = (locale, slug) => `${locale === 'en' ? '' : `${locale}/`}${slug}`;

/**
 * 主流程：拉取 → 转换 → 写文件 → 输出导航与重定向映射。
 */
async function main() {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`Payload API ${res.status}`);
  const { docs } = await res.json();

  const published = new Map();
  for (const doc of docs) {
    if (!doc.markdownContent?.trim()) continue;
    if (!LOCALES.includes(doc.locale) || !KNOWN.has(doc.slug)) {
      throw new Error(`unmapped doc ${doc.locale}/${doc.slug}: add it to TABS`);
    }
    published.set(`${doc.locale}:${doc.slug}`, doc);
  }

  const imageCache = new Map();
  for (const doc of published.values()) {
    let body = convertComponents(doc.markdownContent);
    body = demoteBodyH1(body);
    body = await localizeImages(body, doc.slug, imageCache);
    const file = join(ROOT, `${pagePath(doc.locale, doc.slug)}.mdx`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${frontmatter(doc)}\n${body.trim()}\n`, 'utf8');
  }

  const redirects = { '/docs': '/', '/zh/docs': '/zh' };
  for (const doc of published.values()) {
    const prefix = doc.locale === 'en' ? '' : `/${doc.locale}`;
    redirects[`${prefix}/docs/${doc.slug}`] = `/${pagePath(doc.locale, doc.slug)}`;
  }
  await writeFile(
    join(ROOT, 'scripts/navigation.generated.json'),
    `${JSON.stringify(buildNavigation(published), null, 2)}\n`
  );
  await writeFile(
    join(ROOT, 'scripts/redirects-map.json'),
    `${JSON.stringify(redirects, null, 2)}\n`
  );
  console.log(`exported ${published.size} pages, ${imageCache.size} images`);
}

/** navigation.languages：每种语言一套 Tab → 分组 */
function buildNavigation(published) {
  return LOCALES.map((locale) => ({
    language: locale,
    tabs: TABS.map((t) => ({
      tab: t.tab[locale],
      icon: t.icon,
      groups: t.groups
        .map((g) => ({
          group: g.name[locale],
          icon: g.icon,
          pages: g.slugs
            .filter((slug) => published.has(`${locale}:${slug}`))
            .map((slug) => pagePath(locale, slug)),
        }))
        .filter((g) => g.pages.length),
    })),
  }));
}

/** YAML frontmatter；JSON 字符串保证引号/冒号/全角符号安全 */
function frontmatter(doc) {
  const lines = ['---', `title: ${JSON.stringify(doc.title.trim())}`];
  if (doc.description?.trim()) {
    lines.push(`description: ${JSON.stringify(doc.description.trim())}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Fumadocs 组件 → Mintlify 组件（对照 `mint migrate --from fumadocs`）。
 * 只处理代码块之外的文本。
 */
function convertComponents(md) {
  return mapOutsideFences(md, (text) => {
    let s = text;

    // Cards → Columns；Card 的 lucide JSX 图标 → kebab-case 名称
    s = s.replace(/<Cards>/g, '<Columns cols={2}>').replace(/<\/Cards>/g, '</Columns>');
    s = s.replace(/icon=\{<([A-Z][A-Za-z0-9]*)[^>]*\/>\}/g, (_, name) => `icon="${kebab(name)}"`);

    // Tabs items={[...]} → Tabs；Tab value → Tab title
    s = s.replace(/<Tabs\s+items=\{\[[^\]]*\]\}\s*>/g, '<Tabs>');
    s = s.replace(/<Tab\s+value=("[^"]*")\s*>/g, '<Tab title=$1>');

    // Accordions → AccordionGroup
    s = s.replace(/<Accordions>/g, '<AccordionGroup>').replace(/<\/Accordions>/g, '</AccordionGroup>');

    // Step：小标题或首行文字 → title 属性（Mintlify 的 Step 必须有 title）
    s = s.replace(/<Step>\s*\n+([^\n]+)\n?/g, (_, first) => {
      const heading = first.match(/^#{2,4}\s+(.+?)\s*$/);
      const title = (heading ? heading[1] : first).trim();
      return `<Step title={${JSON.stringify(title)}}>\n`;
    });

    // Callout → 类型化提示框；标题作为加粗首行（Mintlify 的提示框不接受 title）
    s = s.replace(/<Callout([^>]*)>([\s\S]*?)<\/Callout>/g, (_, attrs, inner) => {
      const type = attrs.match(/type="([^"]+)"/)?.[1];
      const title = attrs.match(/title="([^"]+)"/)?.[1];
      const tag =
        { info: 'Info', warn: 'Warning', warning: 'Warning', tip: 'Tip', idea: 'Tip', error: 'Danger', success: 'Check' }[
          type
        ] ?? 'Note';
      const head = title ? `**${title}**\n\n` : '';
      return `<${tag}>\n${head}${inner.trim()}\n</${tag}>`;
    });

    // YoutubeVideo → 响应式 iframe
    s = s.replace(/<YoutubeVideo\s+url="([^"]+)"\s*\/>/g, (_, url) =>
      `<iframe className="w-full aspect-video rounded-xl" src="${url}" title="YouTube video player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />`
    );
    return s;
  });
}

/** 正文里的 H1 降为 H2：frontmatter title 已渲染为页面 H1 */
function demoteBodyH1(md) {
  return mapOutsideFences(md, (text) => text.replace(/^# (?=\S)/gm, '## '));
}

/** 把 cdn.sectionly.ai 图片下载到 /images/<slug>/<hash>.<ext>，改写为站内路径 */
async function localizeImages(md, slug, cache) {
  const re = /(!\[[^\]]*\]\()<?(https:\/\/cdn\.sectionly\.ai\/[^\s)>]+)>?/g;
  const urls = [...new Set([...md.matchAll(re)].map((m) => m[2]))];
  for (const url of urls) {
    if (!cache.has(url)) cache.set(url, await downloadImage(url, slug));
  }
  return md.replace(re, (_, pre, url) => `${pre}${cache.get(url)}`);
}

/** 下载单张图片，扩展名优先取 Content-Type */
async function downloadImage(url, slug) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${res.status}: ${url}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  const ext =
    { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[type] ||
    url.split('.').pop().toLowerCase();
  const name = `${createHash('sha1').update(url).digest('hex').slice(0, 10)}.${ext}`;
  const rel = `/images/${slug}/${name}`;
  await mkdir(dirname(join(ROOT, rel)), { recursive: true });
  await writeFile(join(ROOT, rel), Buffer.from(await res.arrayBuffer()));
  return rel;
}

/** 只对代码块之外的片段应用转换 */
function mapOutsideFences(md, fn) {
  const parts = md.split(/(^```[\s\S]*?^```[^\n]*$)/m);
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join('');
}

/** PascalCase lucide 组件名 → kebab-case 图标名 */
function kebab(name) {
  return name
    .replace(/Icon$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

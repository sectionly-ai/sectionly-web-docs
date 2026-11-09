# Sectionly Docs

Sectionly 产品文档站（Mintlify，https://docs.sectionly.ai）。每个 App 一个顶部 Tab，目前有 **Product Options**；支持 en（根路径）与 zh（`/zh`）。

## 目录

- `docs.json`：站点配置与导航（`navigation.languages[].tabs`）
- `option/<slug>.mdx`、`zh/option/<slug>.mdx`：Product Options 文档
- `images/option/<slug>/`：文档图片
- `scripts/export-payload.mjs`：从官网 Payload CMS 迁移文档的一次性脚本（已完成）
- `scripts/redirects-map.json`：官网旧 `/docs/<slug>`、`/zh/docs/<slug>` → 新路径，供官网 `proxy.ts` 做 301

## 编辑文档

文档**直接在本仓库编辑**，官网 Payload 里的旧 docs 只是存档。

- 新增页面：在对应目录新建 `.mdx`，并把路径加进 `docs.json` 中英文两份 `navigation.languages`。
- 新增 App 文档：在 `docs.json` 两种语言里各加一个 Tab，目录按 App 分（如 `b2b/`、`reviews/`）。
- 不要随意移动已有页面（= URL）：官网 301 映射依赖这些路径；确需移动时在 `docs.json` 加 `redirects` 并同步官网映射。
- **不要重新运行** `scripts/export-payload.mjs`：会用 Payload 旧内容覆盖本仓库的修改（脚本默认拒绝执行，需 `--force`）。

## 本地预览与检查

```bash
npx mint@latest dev --classic
npx mint@latest validate
npx mint@latest broken-links
```

## 发布

推送到 `main` 后由 Mintlify GitHub App 自动部署，CDN 刷新通常需要 1–2 分钟。

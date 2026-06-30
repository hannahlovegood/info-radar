# 信息雷达 mini

`agents-radar` 核心体验的**轻量复刻版**：每天抓 AI 相关链接 → 去重 → 打分 → Top 5 推荐（每条配一句推荐理由）→ 同时出**控制台 + Markdown 日报 + 网页**三种产出。

- **零密钥也能跑**：4 个免费公开源（Hacker News / Dev.to / Lobste.rs / GitHub Trending），不要 LLM key、不要 GitHub token。
- **零依赖**：Node 内置 `fetch`，不用 `npm install`。
- **可升级**：配一个 LLM key（OpenAI 兼容 或 Anthropic）就能让模型写推荐理由；配不上/没配自动降级启发式，永不报错。

## 跑法

```bash
node radar.mjs            # 零密钥：启发式推荐理由
```

跑完会：① 控制台打印 Top 5 ② 写 `digests/YYYY-MM-DD.md` 日报 ③ 生成 `index.html`（双击用浏览器打开）。

### 想让 AI 写推荐理由（可选）

任选一种，国内可直连的 OpenAI 兼容接口最省事：

```bash
# DeepSeek（示例）
LLM_BASE_URL=https://api.deepseek.com LLM_API_KEY=sk-xxx LLM_MODEL=deepseek-chat node radar.mjs

# 通义千问（DashScope 兼容模式）
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode LLM_API_KEY=sk-xxx LLM_MODEL=qwen-plus node radar.mjs

# Kimi / 月之暗面
LLM_BASE_URL=https://api.moonshot.cn LLM_API_KEY=sk-xxx LLM_MODEL=moonshot-v1-8k node radar.mjs

# Anthropic（直接用官方 key）
ANTHROPIC_API_KEY=sk-ant-xxx node radar.mjs
```

> 只调用 **1 次** LLM（5 条理由一起生成），成本可忽略；调用失败会自动降级启发式，不影响出结果。

## 它怎么工作（4 步）

1. **抓**：并行查 4 个源（HN 6 关键词、Dev.to 3 标签、Lobste.rs ai 分类、GitHub Trending 取「今日新增 star」）。
2. **去重**：URL 归一化（去 www / 末尾斜杠 / 追踪参数）；跨源同一篇**合并并累加热度**（被多社区转发 = 更强信号）。
3. **打分**：`得分 = 源内归一化热度(0–100) × 时效`。
   - 为什么归一化：GitHub 的 star、HN 的赞、Dev.to 的 reaction **量纲天差地别**，直接比会让某个源刷屏。先在各源内拉到同一把 0–100 尺，再比。
   - 时效 = `0.5 ^ (年龄 / 48h)`（每 48 小时减半）；GitHub Trending 视为「今天」。
4. **推荐**：取分数最高的 5 条，各配一句理由（LLM 或启发式）。

## 想改什么，改这里

`radar.mjs` 顶部常量：`PER_SOURCE`（每源取几条）、`TOP_N`（推荐几条）、`RECENCY_HALFLIFE_H`（时效半衰期）、`COMMENT_WEIGHT`（评论权重）、`AI_RE`（相关性关键词）。

加新数据源：照着 `fetchHN / fetchDevto / fetchLobsters / fetchGitHubTrending` 写一个返回 `{source,title,url,points,comments,createdAt,note}` 数组的函数，塞进 `main()` 的 `Promise.all`。

## 想每天自动跑

- 简单：`/loop` 或在终端 `while true; do node radar.mjs; sleep 86400; done`。
- 正经：macOS `crontab -e` 加一行 `0 8 * * * cd ~/Documents/Claude/信息雷达 && /usr/local/bin/node radar.mjs`。

## 和原项目的关系

| | 原版 agents-radar | 这个 mini 版 |
|---|---|---|
| 数据源 | 10 个 | 4 个（免密钥的） |
| 打分/筛选 | LLM 写双语摘要 | 源内归一化打分 + 关键词过滤 |
| 推荐理由 | LLM | LLM **或** 启发式（自动降级） |
| 产出 | Markdown + GitHub Issue + Web/RSS/Telegram/飞书 + MCP | 控制台 + Markdown 日报 + 单文件网页 |
| 需要 | LLM key + GitHub token | **零密钥可跑**，key 可选 |

---
*复刻自 [duanyytop/agents-radar](https://github.com/duanyytop/agents-radar)*

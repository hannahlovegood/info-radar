#!/usr/bin/env node
/**
 * 信息雷达 mini — agents-radar 的核心体验（轻量复刻版 v2）
 * ------------------------------------------------------------------
 * 抓 → 去重 → 打分 → Top 5 推荐，外加：
 *   ① 4 个数据源：Hacker News / Dev.to / Lobste.rs / GitHub Trending（全部免密钥）
 *   ② 网页输出：生成自包含的 index.html，双击即可在浏览器打开
 *   ③ AI 推荐理由：每条 Top 推荐配一句话「为什么值得看」
 *        - 有 LLM key（OpenAI 兼容 或 Anthropic）→ 让模型写
 *        - 没有 key → 自动降级成可解释的启发式理由（零成本仍可用）
 *
 * 跑法：
 *   node radar.mjs                      # 零密钥，启发式理由
 *   LLM_BASE_URL=https://api.deepseek.com LLM_API_KEY=sk-xxx LLM_MODEL=deepseek-chat node radar.mjs
 *   ANTHROPIC_API_KEY=sk-ant-xxx node radar.mjs
 * ------------------------------------------------------------------
 */

import fs from "node:fs";
import path from "node:path";

// ── 配置 ────────────────────────────────────────────────────────────
const PER_SOURCE = 15;
const TOP_N = 5;
const RECENCY_HALFLIFE_H = 48;
const COMMENT_WEIGHT = 2;
const UA = { "User-Agent": "info-radar-mini/2.0 (learning demo)" };

// ── 相关性闸门（关键词搜索源用它过滤噪音；标签/分类源本身已干净）──────
const AI_RE =
  /\b(ai|a\.i\.|llm|llms|gpt|chatgpt|claude|anthropic|openai|gemini|grok|llama|mistral|qwen|deepseek|kimi|agent|agentic|machine\s*learning|ml|neural|deep\s*learning|transformer|diffusion|rag|embedding|chatbot|copilot|hugging\s*face|inference|fine[- ]?tun|prompt|model|gpu|cuda|pytorch|tensor)\b/i;
const looksAI = (t = "") => AI_RE.test(t);

// ── 带超时的 fetch ──────────────────────────────────────────────────
async function getText(url, ms = 15000, headers = UA) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}
const getJSON = async (url, ms) => JSON.parse(await getText(url, ms));

// ── 源 1：Hacker News（Algolia，同原项目 hn.ts）──────────────────────
async function fetchHN() {
  const since = Math.floor((Date.now() - 3 * 864e5) / 1000);
  const queries = ["AI", "LLM", "Claude", "OpenAI", "Anthropic", "machine learning"];
  const seen = new Map();
  await Promise.all(
    queries.map(async (q) => {
      try {
        const data = await getJSON(
          `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${encodeURIComponent(q)}&numericFilters=created_at_i>${since}&hitsPerPage=20`
        );
        for (const h of data.hits ?? []) {
          if (!h.title || seen.has(h.objectID)) continue;
          seen.set(h.objectID, {
            source: "HN", title: h.title,
            url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
            points: h.points ?? 0, comments: h.num_comments ?? 0,
            createdAt: h.created_at, note: "",
          });
        }
      } catch (e) { console.error(`  [HN] "${q}" 失败: ${e.message}`); }
    })
  );
  return [...seen.values()].filter((it) => looksAI(it.title))
    .sort((a, b) => b.points - a.points).slice(0, PER_SOURCE);
}

// ── 源 2：Dev.to（Forem，同原项目 devto.ts）─────────────────────────
async function fetchDevto() {
  const tags = ["ai", "llm", "machinelearning"];
  const seen = new Map();
  await Promise.all(
    tags.map(async (tag) => {
      try {
        const arr = await getJSON(`https://dev.to/api/articles?tag=${tag}&top=7&per_page=15`);
        for (const a of arr ?? []) {
          if (!a.title || seen.has(a.id)) continue;
          seen.set(a.id, {
            source: "Dev.to", title: a.title, url: a.url,
            points: a.positive_reactions_count ?? 0, comments: a.comments_count ?? 0,
            createdAt: a.published_at ?? a.published_timestamp, note: "",
          });
        }
      } catch (e) { console.error(`  [Dev.to] "${tag}" 失败: ${e.message}`); }
    })
  );
  return [...seen.values()].filter((it) => looksAI(it.title))
    .sort((a, b) => b.points - a.points).slice(0, PER_SOURCE);
}

// ── 源 3：Lobste.rs（JSON，同原项目 lobsters.ts；源头已按 ai 标签过滤）──
async function fetchLobsters() {
  try {
    const arr = await getJSON("https://lobste.rs/t/ai.json");
    return (arr ?? []).filter((s) => s.title).map((s) => ({
      source: "Lobste.rs", title: s.title, url: s.url || s.short_id_url,
      points: s.score ?? 0, comments: s.comment_count ?? 0,
      createdAt: s.created_at, note: "",
    })).sort((a, b) => b.points - a.points).slice(0, PER_SOURCE);
  } catch (e) { console.error(`  [Lobste.rs] 失败: ${e.message}`); return []; }
}

// ── 源 4：GitHub Trending（抓 HTML 取「今日新增 star」，同原项目 trending.ts）──
async function fetchGitHubTrending() {
  try {
    const html = await getText("https://github.com/trending?since=daily", 15000, {
      "User-Agent": "Mozilla/5.0 (compatible; info-radar-mini/2.0)", Accept: "text/html",
    });
    const blocks = html.match(/<article[^>]*class="[^"]*Box-row[^"]*"[\s\S]*?(?=<article[^>]*class="[^"]*Box-row[^"]*"|$)/g) ?? [];
    const out = [];
    for (const b of blocks) {
      const name = b.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="\/([^/"]+\/[^/"]+)"/)?.[1]?.trim();
      if (!name) continue;
      const desc = (b.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "")
        .replace(/<[^>]+>/g, "").trim();
      const todayStars = parseInt((b.match(/([\d,]+)\s+stars?\s+today/i)?.[1] ?? "0").replace(/,/g, ""), 10);
      out.push({
        source: "GitHub", title: name, url: `https://github.com/${name}`,
        points: todayStars, comments: 0,
        createdAt: new Date().toISOString(), // trending = 今天，视为最新
        note: desc,
      });
    }
    // GitHub Trending 不全是 AI → 用关键词在「仓库名+简介」上过滤
    return out.filter((it) => looksAI(it.title + " " + it.note))
      .sort((a, b) => b.points - a.points).slice(0, PER_SOURCE);
  } catch (e) { console.error(`  [GitHub] 失败: ${e.message}`); return []; }
}

// ── 去重：URL 归一化 + 跨源合并（合并的累加热度、并记多来源）─────────
function canonical(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, "") + u.pathname.replace(/\/+$/, "");
  } catch { return url; }
}
function dedupe(items) {
  const map = new Map();
  let merged = 0;
  for (const it of items) {
    const key = canonical(it.url);
    if (map.has(key)) {
      const p = map.get(key);
      p.points += it.points; p.comments += it.comments;
      if (!p.sources.includes(it.source)) p.sources.push(it.source);
      if (!p.note && it.note) p.note = it.note;
      merged++;
    } else map.set(key, { ...it, sources: [it.source] });
  }
  return { items: [...map.values()], merged };
}

// ── 打分：源内归一化(0–100) × 时效 ──────────────────────────────────
// 为什么归一化：GitHub 的 star、HN 的赞、Dev.to 的 reaction 量纲天差地别，
// 直接比会让某个源刷屏。先在「各自源内」把热度拉到 0–100 同一把尺，再 × 时效。
function score(items) {
  const rawHeat = (it) => it.points + COMMENT_WEIGHT * it.comments;
  // 按主来源分组求 min/max
  const groups = {};
  for (const it of items) {
    const g = it.sources[0];
    (groups[g] ??= []).push(rawHeat(it));
  }
  const bounds = {};
  for (const [g, arr] of Object.entries(groups)) bounds[g] = { min: Math.min(...arr), max: Math.max(...arr) };

  const now = Date.now();
  return items.map((it) => {
    const g = it.sources[0];
    const { min, max } = bounds[g];
    const raw = rawHeat(it);
    const normHeat = max === min ? 60 : (100 * (raw - min)) / (max - min);
    const ageH = Math.max(0, (now - new Date(it.createdAt).getTime()) / 3.6e6);
    const recency = Math.pow(0.5, ageH / RECENCY_HALFLIFE_H);
    return { ...it, raw, normHeat, ageH, recency, score: normHeat * recency };
  }).sort((a, b) => b.score - a.score);
}

// ── 推荐理由：优先 LLM，失败/无 key 自动降级启发式 ──────────────────
function heuristicReason(it) {
  if (it.sources.length > 1) return `被 ${it.sources.join(" + ")} 同时转发，跨社区共识强。`;
  if (it.source === "GitHub") return `GitHub 今日新增 ${it.points} 星，项目正在起势。`;
  if (it.comments > it.points) return `讨论度高于点赞（${it.comments} 评论），话题性强，值得看评论区。`;
  if (it.ageH < 12) return `${it.ageH.toFixed(0)} 小时内冒头就冲上来，时效性强。`;
  return `${it.source} 高热（${it.points} 赞 / ${it.comments} 评论），社区认可度高。`;
}

async function llmReasons(top) {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const list = top.map((it, i) =>
    `${i + 1}. [${it.sources.join("+")}] ${it.title}${it.note ? " — " + it.note : ""}（热度${it.raw}）`
  ).join("\n");
  const prompt =
    `你是 AI 资讯编辑。下面是今日 Top ${top.length} 条 AI 相关链接。` +
    `请为每条写一句不超过 30 字的中文推荐理由，说明它为什么值得点开。` +
    `只输出一个 JSON 数组（${top.length} 个字符串），不要任何多余文字。\n\n${list}`;

  try {
    let text;
    if (baseUrl && apiKey) {
      // OpenAI 兼容接口（DeepSeek / Kimi / 通义 / 智谱 等都支持）
      const r = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`.replace("/v1/v1/", "/v1/"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.4,
        }),
      });
      if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
      text = (await r.json()).choices?.[0]?.message?.content ?? "";
    } else if (anthropicKey) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}`);
      text = (await r.json()).content?.[0]?.text ?? "";
    } else {
      return { reasons: top.map(heuristicReason), via: "启发式（未配置 LLM key）" };
    }
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    if (!Array.isArray(arr) || arr.length < top.length) throw new Error("LLM 返回格式异常");
    return { reasons: arr.slice(0, top.length).map(String), via: "LLM" };
  } catch (e) {
    console.error(`  [LLM] 失败，降级启发式：${e.message}`);
    return { reasons: top.map(heuristicReason), via: `启发式（LLM 失败：${e.message}）` };
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log("📡 信息雷达 mini v2 启动 …（4 源，零密钥可跑）\n");

  const [hn, devto, lob, gh] = await Promise.all([
    fetchHN(), fetchDevto(), fetchLobsters(), fetchGitHubTrending(),
  ]);
  const raw = [...hn, ...devto, ...lob, ...gh];
  console.log(`① 抓取：HN ${hn.length} + Dev.to ${devto.length} + Lobste.rs ${lob.length} + GitHub ${gh.length} = ${raw.length} 条`);

  const { items, merged } = dedupe(raw);
  console.log(`② 去重：${raw.length} → ${items.length} 条（合并 ${merged} 组跨源/重复）`);

  const ranked = score(items);
  console.log(`③ 打分：源内归一化(0–100) × 时效，候选池 ${ranked.length} 条`);

  const top = ranked.slice(0, TOP_N);
  const { reasons, via } = await llmReasons(top);
  top.forEach((it, i) => (it.reason = reasons[i]));
  console.log(`④ 推荐理由来源：${via}\n`);

  console.log(`⭐ 今日 Top ${TOP_N} 推荐 ──────────────────────────────────────`);
  top.forEach((it, i) => {
    console.log(`\n${i + 1}. [${it.sources.join("+")}] ${it.title}`);
    console.log(`   ${it.url}`);
    console.log(`   💡 ${it.reason}`);
    console.log(`   📊 ${it.score.toFixed(0)} 分 = 热度 ${it.normHeat.toFixed(0)}/100（原始 ${it.raw}）× 时效 ${it.recency.toFixed(2)}`);
  });

  // 产出：Markdown 日报 + 自包含网页
  const today = new Date().toISOString().slice(0, 10);
  const stats = { raw: raw.length, dedup: items.length, merged, via };
  const outDir = path.join(import.meta.dirname, "digests");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${today}.md`), renderMarkdown(today, stats, top, ranked), "utf-8");
  const htmlPath = path.join(import.meta.dirname, "index.html");
  fs.writeFileSync(htmlPath, renderHTML(today, stats, top, ranked), "utf-8");

  console.log(`\n📝 日报：digests/${today}.md`);
  console.log(`🌐 网页：${htmlPath}（双击用浏览器打开）`);
  console.log(`⏱️  全程 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ── 渲染：Markdown ──────────────────────────────────────────────────
function renderMarkdown(date, s, top, all) {
  const L = [`# 信息雷达 · ${date}\n`];
  L.push(`> 抓取 ${s.raw} 条 → 去重 ${s.dedup} 条（合并 ${s.merged} 组）→ 打分 → Top ${top.length}`);
  L.push(`> 4 源：Hacker News · Dev.to · Lobste.rs · GitHub Trending（均免密钥）｜推荐理由：${s.via}\n`);
  L.push(`## ⭐ 今日 Top ${top.length} 推荐\n`);
  top.forEach((it, i) => {
    L.push(`### ${i + 1}. ${it.title}`);
    L.push(`- 🔗 ${it.url}`);
    if (it.note) L.push(`- 📄 ${it.note}`);
    L.push(`- 📡 ${it.sources.join(" + ")}　💡 ${it.reason}`);
    L.push(`- 📊 **${it.score.toFixed(0)} 分** = 热度 ${it.normHeat.toFixed(0)}/100（原始 ${it.raw}）× 时效 ${it.recency.toFixed(2)}\n`);
  });
  L.push(`\n<details><summary>📋 完整候选池（${all.length} 条）</summary>\n`);
  all.forEach((it, i) => L.push(`${i + 1}. [${it.sources.join("+")}] [${it.title}](${it.url}) — ${it.score.toFixed(0)} 分`));
  L.push(`\n</details>\n\n---\n*信息雷达 mini · 复刻自 [agents-radar](https://github.com/duanyytop/agents-radar)*`);
  return L.join("\n");
}

// ── 渲染：自包含网页（深色主题，数据内嵌，file:// 直接打开）──────────
function renderHTML(date, s, top, all) {
  const data = JSON.stringify({ date, stats: s, top, all }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>信息雷达 · ${date}</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#21262d;--fg:#e6edf3;--mut:#8b949e;--acc:#58a6ff;--gold:#e3b341}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"PingFang SC",Segoe UI,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:32px 18px 64px}
h1{font-size:24px;margin:0 0 6px}.sub{color:var(--mut);font-size:13px;margin-bottom:24px}
.sub b{color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:12px 0;transition:.15s}
.card:hover{border-color:var(--acc)}
.rank{display:inline-block;min-width:26px;height:26px;line-height:26px;text-align:center;border-radius:7px;background:var(--gold);color:#000;font-weight:700;margin-right:8px}
.ttl{font-size:17px;font-weight:600;text-decoration:none;color:var(--fg)}.ttl:hover{color:var(--acc)}
.badge{font-size:11px;color:var(--acc);border:1px solid var(--acc);border-radius:5px;padding:1px 6px;margin-left:6px;opacity:.85}
.note{color:var(--mut);font-size:13px;margin:6px 0}
.reason{margin:8px 0;font-size:14px}.reason b{color:var(--gold)}
.bar{height:6px;background:#21262d;border-radius:4px;overflow:hidden;margin:8px 0 4px}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,#58a6ff,#e3b341)}
.meta{color:var(--mut);font-size:12px}
details{margin-top:28px}summary{cursor:pointer;color:var(--mut)}
.row{padding:6px 0;border-bottom:1px solid var(--line);font-size:13px}.row a{color:var(--fg);text-decoration:none}.row a:hover{color:var(--acc)}
.foot{margin-top:40px;color:var(--mut);font-size:12px;text-align:center}
.foot a{color:var(--acc)}
</style></head><body><div class="wrap">
<h1>📡 信息雷达 · <span id="d"></span></h1>
<div class="sub" id="sub"></div>
<div id="top"></div>
<details><summary id="more"></summary><div id="all"></div></details>
<div class="foot">信息雷达 mini · 复刻自 <a href="https://github.com/duanyytop/agents-radar" target="_blank">agents-radar</a> 的核心体验</div>
</div>
<script>
const D=${data};
document.getElementById('d').textContent=D.date;
document.getElementById('sub').innerHTML=
 '抓取 <b>'+D.stats.raw+'</b> 条 → 去重 <b>'+D.stats.dedup+'</b> 条（合并 '+D.stats.merged+' 组）→ 打分 → Top '+D.top.length+
 '　·　4 源全免密钥　·　推荐理由：'+D.stats.via;
const maxS=Math.max.apply(null,D.top.map(t=>t.score))||1;
document.getElementById('top').innerHTML=D.top.map((it,i)=>
 '<div class="card"><div><span class="rank">'+(i+1)+'</span>'+
 '<a class="ttl" href="'+it.url+'" target="_blank">'+esc(it.title)+'</a>'+
 it.sources.map(x=>'<span class="badge">'+x+'</span>').join('')+'</div>'+
 (it.note?'<div class="note">'+esc(it.note)+'</div>':'')+
 '<div class="reason">💡 <b>'+esc(it.reason||'')+'</b></div>'+
 '<div class="bar"><i style="width:'+(it.score/maxS*100).toFixed(0)+'%"></i></div>'+
 '<div class="meta">📊 '+it.score.toFixed(0)+' 分 = 热度 '+it.normHeat.toFixed(0)+'/100（原始 '+it.raw+'）× 时效 '+it.recency.toFixed(2)+'</div>'+
 '</div>').join('');
document.getElementById('more').textContent='📋 完整候选池（'+D.all.length+' 条）';
document.getElementById('all').innerHTML=D.all.map((it,i)=>
 '<div class="row">'+(i+1)+'. <a href="'+it.url+'" target="_blank">'+esc(it.title)+'</a> '+
 '<span class="badge">'+it.sources.join('+')+'</span> — '+it.score.toFixed(0)+' 分</div>').join('');
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
</script></body></html>`;
}

main().catch((e) => { console.error("❌ 运行失败：", e); process.exit(1); });

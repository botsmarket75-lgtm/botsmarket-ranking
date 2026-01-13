const fs = require("fs");
const path = require("path");

function dayKey(d = new Date()){
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,"0");
  const da=String(d.getDate()).padStart(2,"0");
  return `${y}${m}${da}`;
}
function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }

const today = dayKey();
const y = new Date(); y.setDate(y.getDate()-1);
const yesterday = dayKey(y);

const solutions = JSON.parse(fs.readFileSync("solutions.json","utf8"));

const histDir = "history";
if(!fs.existsSync(histDir)) fs.mkdirSync(histDir);

// ✅ NOUVEAU : on lit prev_ranking.json à la racine (PRIORITÉ)
const prevRootPath = "prev_ranking.json";
// (fallback historique : ton ancien mécanisme)
const prevHistPath = path.join(histDir, `${yesterday}.json`);

let prev = null;
try{
  if(fs.existsSync(prevRootPath)){
    prev = JSON.parse(fs.readFileSync(prevRootPath,"utf8"));
  }else{
    prev = JSON.parse(fs.readFileSync(prevHistPath,"utf8"));
  }
}catch(e){
  prev = null;
}

const prevRankMap = new Map();
const prevScoreMap = new Map();
if(prev && Array.isArray(prev.rows)){
  for(const r of prev.rows){
    if(r && r.name && typeof r.rank === "number") prevRankMap.set(r.name, r.rank);
    if(r && r.name && typeof r.score === "number") prevScoreMap.set(r.name, r.score);
  }
}

const POS = ["launch","launched","release","released","ga","generally available","update","updated","introduces","introducing","new","partner","partnership","certified","wins","award","improves","improved","secure","security update","performance"];
const NEG = ["outage","incident","downtime","breach","vulnerability","cve","lawsuit","fine","bug","issue","degraded","disruption","leak","hack","compromised","regression"];
const CENTRAL = ["g2","trustradius","trust radius","gartner","magic quadrant","forrester","forrester wave"];

function safeText(s){ return (s||"").toLowerCase(); }

function googleNewsRss(q){
  const query = encodeURIComponent(`${q} (AI OR agent OR copilot OR assistant OR automation OR platform)`);
  return `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
}
function centralSignalsRss(q){
  const query = encodeURIComponent(`${q} (G2 OR TrustRadius OR Gartner OR "Magic Quadrant" OR Forrester OR "Forrester Wave")`);
  return `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
}

async function fetchText(url, timeoutMs=12000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if(!res.ok) throw new Error(`fetch ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function parseRssItems(xmlText, limit=25){
  const items = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const titleRe = /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i;
  const dateRe  = /<pubDate>([\s\S]*?)<\/pubDate>/i;

  const matches = xmlText.match(itemRe) || [];
  for(let i=0;i<Math.min(matches.length, limit);i++){
    const it = matches[i];
    const tm = it.match(titleRe);
    const dm = it.match(dateRe);
    const title = (tm && (tm[1]||tm[2])) ? (tm[1]||tm[2]).trim() : "";
    const pubDate = dm ? new Date(dm[1].trim()) : null;
    if(title) items.push({ title, pubDate });
  }
  return items;
}

function dedupeItems(items, limit=50){
  const seen = new Set();
  const out = [];
  for(const it of items){
    const k = safeText(it.title).replace(/\s+/g," ").trim();
    if(!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if(out.length>=limit) break;
  }
  return out;
}

function scoreFromSignals(items){
  const now = Date.now();
  const sevenDays = 7*24*60*60*1000;

  let pos=0, neg=0, recent=0, centralHits=0;

  for(const it of items){
    const t = safeText(it.title);
    for(const w of POS) if(t.includes(w)) pos++;
    for(const w of NEG) if(t.includes(w)) neg++;
    for(const w of CENTRAL) if(t.includes(w)) centralHits++;
    if(it.pubDate && (now - it.pubDate.getTime()) <= sevenDays) recent++;
  }

  const mentions = items.length;

  const raw =
    ((pos - neg) * 0.5) +
    (Math.log(mentions + 1) * 0.6) +
    (recent * 0.10) +
    (centralHits * 0.45);

  const delta = clamp(Math.round(raw), -6, 6);

  return { delta, mentions, recent, pos, neg, centralHits };
}

async function mapLimit(arr, limit, mapper){
  const out = new Array(arr.length);
  let i = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async ()=>{
    while(i < arr.length){
      const idx = i++;
      try { out[idx] = await mapper(arr[idx], idx); }
      catch(e){ out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

function capDailyMove(todayScore, yesterdayScore, cap=2){
  if(typeof yesterdayScore !== "number") return todayScore;
  const diff = todayScore - yesterdayScore;
  if(diff > cap) return yesterdayScore + cap;
  if(diff < -cap) return yesterdayScore - cap;
  return todayScore;
}

async function build(){
  const signals = await mapLimit(solutions, 6, async (s)=>{
    const [xmlMarket, xmlCentral] = await Promise.all([
      fetchText(googleNewsRss(s.name)),
      fetchText(centralSignalsRss(s.name))
    ]);

    const items = dedupeItems([
      ...parseRssItems(xmlMarket, 25),
      ...parseRssItems(xmlCentral, 25)
    ], 50);

    const m = scoreFromSignals(items);
    return { name: s.name, ...m };
  });

  const sigMap = new Map();
  for(const m of signals){
    if(m && m.name) sigMap.set(m.name, m);
  }

  let rows = solutions.map(s=>{
    const base = clamp(s.base ?? 75, 60, 95);
    const agentic = clamp(60 + (s.agentic ?? 10)*1.1, 60, 95);

    const sig = sigMap.get(s.name);
    const market_delta = sig ? sig.delta : 0;

    const base_market = clamp(base + market_delta, 60, 95);

    let score = clamp(Math.round(0.70*base_market + 0.30*agentic), 60, 95);
    score = capDailyMove(score, prevScoreMap.get(s.name), 2);

    return {
      name: s.name,
      website: s.website,
      category: s.category,
      score,
      market_delta,
      market_meta: sig ? {
        mentions: sig.mentions,
        recent: sig.recent,
        pos: sig.pos,
        neg: sig.neg,
        centralHits: sig.centralHits
      } : { mentions:0, recent:0, pos:0, neg:0, centralHits:0 }
    };
  }).sort((a,b)=>b.score-a.score);

  rows.forEach((r,i)=>r.rank=i+1);

  rows = rows.map(r=>{
    const prevRank = prevRankMap.get(r.name);
    const delta_rank = (typeof prevRank === "number") ? (prevRank - r.rank) : null;
    return { ...r, delta_rank };
  });

  const out = {
    date: today,
    prev_date: prev?.date || null,
    methodology: {
      formula: "score = round(0.70*(base + market_delta) + 0.30*agentic) with daily cap ±2",
      market_delta: "Google News RSS + Central Signals RSS (G2/Gartner/Forrester/TrustRadius), weighted stronger",
      note: "Computed server-side (GitHub Actions). Identical for all users."
    },
    rows
  };

  // ranking du jour
  fs.writeFileSync("ranking.json", JSON.stringify(out,null,2));
  // historique
  fs.writeFileSync(path.join(histDir, `${today}.json`), JSON.stringify(out,null,2));
  // ✅ NOUVEAU : on prépare “demain” -> prev_ranking.json
  fs.writeFileSync("prev_ranking.json", JSON.stringify(out,null,2));

  console.log("Generated ranking.json", today);
}

build().catch(err=>{
  console.error(err);
  process.exit(1);
});

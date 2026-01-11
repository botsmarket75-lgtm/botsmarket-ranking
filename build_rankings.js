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

function dailyNoise(name){
  let h = 0;
  const s = `${today}:${name}`;
  for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
  const r = (h % 1000) / 1000;
  return (r - 0.5) * 2; // -1..+1
}

const histDir = "history";
if(!fs.existsSync(histDir)) fs.mkdirSync(histDir);

const prevPath = path.join(histDir, `${yesterday}.json`);

// 1) Charger le ranking d'hier (source de vérité pour delta)
let prev = null;
try{
  prev = JSON.parse(fs.readFileSync(prevPath,"utf8"));
}catch(e){
  prev = null;
}

const prevRankMap = new Map();
if(prev && Array.isArray(prev.rows)){
  for(const r of prev.rows){
    if(r && r.name && typeof r.rank === "number") prevRankMap.set(r.name, r.rank);
  }
}

// 2) Calculer le nouveau ranking
let rows = solutions.map(s=>{
  const base = clamp(s.base ?? 75, 60, 95);
  const agentic = clamp(60 + (s.agentic ?? 10)*1.1, 60, 95);
  const score = clamp(Math.round(0.70*base + 0.30*agentic + dailyNoise(s.name)), 60, 95);
  return { name: s.name, website: s.website, category: s.category, score };
}).sort((a,b)=>b.score-a.score);

rows.forEach((r,i)=>r.rank=i+1);

// 3) Delta rang vs hier
rows = rows.map(r=>{
  const prevRank = prevRankMap.get(r.name);
  const delta_rank = (typeof prevRank === "number") ? (prevRank - r.rank) : null;
  return { ...r, delta_rank };
});

// 4) Ecrire ranking.json + archiver dans history
const out = {
  date: today,
  prev_date: prev?.date || null,
  methodology: { formula: "score = round(0.70*base + 0.30*agentic + dailyNoise)" },
  rows
};

fs.writeFileSync("ranking.json", JSON.stringify(out,null,2));
fs.writeFileSync(path.join(histDir, `${today}.json`), JSON.stringify(out,null,2));

console.log("Generated ranking.json", today);

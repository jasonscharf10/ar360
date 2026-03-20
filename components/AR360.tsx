"use client";
/**
 * AR360 — main app component.
 * Drop the full contents of the Claude artifact here,
 * with two changes:
 *
 * 1. Add the `user` prop to the App signature:
 *      export default function App({ user }: { user: { name?: string; email?: string; image?: string } | undefined })
 *
 * 2. Replace the callClaude fetch URL and remove the api key header:
 *      const res = await fetch("/api/claude", {
 *        method: "POST",
 *        headers: { "Content-Type": "application/json" },
 *        body: JSON.stringify(body),
 *      });
 *
 * 3. Optionally surface the user in the nav bar:
 *      <img src={user?.image} style={{width:28,height:28,borderRadius:"50%"}} />
 */

// Paste your AR360 artifact code here

import { useState, useRef } from "react";
import { signOut } from "next-auth/react";
import Papa from "papaparse";

const GMAIL_MCP = { type:"url", url:"https://gmail.mcp.claude.com/mcp", name:"gmail" };
const GROUP_INBOX = "accountsreceivable@pandadoc.com";

const C = {
  bg:"#0d1117", surface:"#161b22", surfaceDim:"#0d1117",
  border:"#2a3441", borderDim:"#1a2230",
  text:"#e2e8f0", muted:"#94a3b8", faint:"#64748b", vfaint:"#475569",
  brand:"#21c97a", brandDark:"#17a863", brandGlow:"#21c97a33", greenLight:"#6ee7b7",
  red:"#ef4444", yellow:"#f59e0b", blue:"#60a5fa",
};
const riskColor  = (s: string) => s==="High"?C.red:s==="Medium"?C.yellow:C.brand;
const riskBg     = (s: string) => s==="High"?"#2a1515":s==="Medium"?"#2a2015":"#0e1f17";
const riskBorder = (s: string) => s==="High"?"#7f1d1d":s==="Medium"?"#78350f":"#145235";
const npsColor   = (s: number) => s>=9?C.brand:s>=7?C.yellow:C.red;
const npsBg      = (s: number) => s>=9?"#0e1f17":s>=7?"#2a2015":"#2a1515";
const npsBorder  = (s: number) => s>=9?"#145235":s>=7?"#78350f":"#7f1d1d";
const npsLabel   = (s: number) => s>=9?"Promoter":s>=7?"Passive":"Detractor";
const scoreColor = (s: number) => s>=70?C.red:s>=45?C.yellow:C.brand;
const chanColor  = (s: number) => ({Email:C.brand,Phone:C.yellow,Slack:C.blue,Legal:C.red}[s]||C.brand);

const parseNum = v => parseFloat((v||"").toString().replace(/[^0-9.-]/g,""))||0;
const isValidCurrency = c => /^[A-Z]{3}$/.test(c||"");
const fmt = (n,cur="USD") => n==null||isNaN(n)?"—":Number(n).toLocaleString("en-US",{style:"currency",currency:isValidCurrency(cur)?cur:"USD",maximumFractionDigits:0});
const domainOf = e => (e||"").split("@")[1]?.toLowerCase().trim()||"";
const strip = s => (s||"").trim().replace(/^\uFEFF/,"");

function parseCSV(text) {
  const r = Papa.parse(text.trim(),{header:true,skipEmptyLines:true,dynamicTyping:false,delimitersToGuess:[",","\t","|",";"],transformHeader:h=>strip(h),transform:v=>strip(v)});
  if (!r.data.length) throw new Error("No rows found — check the file format");
  return r.data;
}

function buildCustomers(rows) {
  const map = {};
  for (const r of rows) {
    const name = r["Customer Name"]||"Unknown";
    if (!map[name]) map[name] = {
      name, accountName:r["Account Name"]||"",
      externalId:r["Customer External ID"]||"",
      organizationUuid:r["Organization UUID"]||"",
      accountManager:r["Account Manager"]||"",
      currency:r["Currency"]||"USD",
      emailDomain:"", invoices:[],
    };
    if (!map[name].emailDomain) {
      const emailCols = Object.keys(r).filter(k=>k.toLowerCase().includes("email"));
      for (const k of emailCols) { const d=domainOf(r[k]); if(d){map[name].emailDomain=d;break;} }
    }
    map[name].invoices.push({
      number:r["Invoice Number"], outstanding:parseNum(r["Amount Outstanding"]),
      issueDate:r["Issue Date"], dueDate:r["Due Date"],
      daysOverdue:parseInt((r["Days Overdue"]||"").replace(/[^0-9-]/g,""))||0,
      state:r["State"], workflow:r["Workflow Name"],
    });
  }
  return Object.values(map).map(c=>({
    ...c,
    totalOutstanding:c.invoices.reduce((s,i)=>s+i.outstanding,0),
    maxDaysOverdue:Math.max(0,...c.invoices.map(i=>i.daysOverdue)),
  })).sort((a,b)=>b.totalOutstanding-a.totalOutstanding);
}

function buildUsageIndex(rows) {
  const map = {};
  for (const r of rows) { const k=r["ACCOUNT_CODE"]; if(k){if(!map[k])map[k]=[];map[k].push(r);} }
  return map;
}

function buildNpsIndex(rows) {
  const map = {};
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  const acctCol = cols.find(k => /end_user__properties__account_code/i.test(k)) || "";
  for (const r of rows) {
    const accountCode = acctCol ? r[acctCol]?.trim() : "";
    const key = accountCode || (()=>{
      const emailCols = cols.filter(k=>k.toLowerCase().includes("email"));
      for (const k of emailCols) { const d=domainOf(r[k]); if(d) return d; }
      return "";
    })();
    if (!key) continue;
    if (!map[key]) map[key]=[];
    map[key].push(r);
  }
  return map;
}

function buildTasksIndex(rows) {
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  const idCol = cols.find(k=>/organization_uuid/i.test(k))
    || cols.find(k=>/uuid/i.test(k))
    || cols.find(k=>/accountid/i.test(k))
    || "";
  const map = {};
  for (const r of rows) {
    const key=(r[idCol]||"").trim(); if(!key) continue;
    if(!map[key]) map[key]=[];
    map[key].push(r);
  }
  return { map, idCol, cols, totalRows:rows.length, sampleIds:Object.keys(map).slice(0,5) };
}

function getUsageSummary(c, usageIndex) {
  const rows = usageIndex[c.organizationUuid];
  if (!rows||!rows.length) return null;
  const userIds = new Set(rows.map(r=>r["USER_ID"]).filter(Boolean));
  const dates = rows.map(r=>r["USAGE_DATE"]).filter(Boolean).sort((a,b)=>new Date(a).getTime()-new Date(b).getTime());
  const uc={},ka={};
  for (const r of rows) {
    const u=r["LEVEL_1"]||r["USECASE"]||"unknown"; uc[u]=(uc[u]||0)+1;
    if(r["KEY_ACTION"]) ka[r["KEY_ACTION"]]=(ka[r["KEY_ACTION"]]||0)+1;
  }
  return {totalEvents:rows.length,uniqueUsers:userIds.size,firstActive:dates[0]||"—",lastActive:dates[dates.length-1]||"—",
    topUsecases:Object.entries(uc).sort((a,b)=>b[1]-a[1]).slice(0,5),
    topActions:Object.entries(ka).sort((a,b)=>b[1]-a[1]).slice(0,5)};
}

function getNpsSummary(c, npsIndex) {
  if (!npsIndex) return null;
  const rows = npsIndex[c.organizationUuid] || npsIndex[c.emailDomain] || [];
  if (!rows.length) return null;
  const scoreCol = r => {
    for (const k of ["SCORE","NPS score","NPS Score","Score","score","nps_score","NPS","Rating","rating"]) { const v=parseInt(r[k]); if(!isNaN(v)) return v; }
    return NaN;
  };
  const commentCol = r => { for (const k of ["TEXT","Text","Comment","comment","Verbatim","verbatim","Feedback","feedback"]) { if(r[k]) return r[k]; } return ""; };
  const dateCol = r => { for (const k of ["CREATED_AT","Created At","created_at","Date","date","Submitted At","Timestamp"]) { if(r[k]) return r[k]; } return ""; };
  const scored = rows
    .map(r=>({score:scoreCol(r),comment:commentCol(r),date:dateCol(r)})).filter(r=>!isNaN(r.score));
  if (!scored.length) return null;
  const sorted = [...scored].sort((a,b)=>new Date(b.date)-new Date(a.date));
  const avg = scored.reduce((s,r)=>s+r.score,0)/scored.length;
  return {avg:Math.round(avg*10)/10,count:scored.length,all:sorted,latest:sorted[0],
    promoters:scored.filter(r=>r.score>=9).length,passives:scored.filter(r=>r.score>=7&&r.score<=8).length,
    detractors:scored.filter(r=>r.score<=6).length};
}

function getTasks(c, tasksIndex) {
  if (!tasksIndex||!c.organizationUuid) return [];
  const rows = tasksIndex.map[c.organizationUuid.trim()]||[];
  return rows.map(r=>{
    const f=(candidates)=>{ for(const k of candidates){if(r[k]&&r[k].trim()) return r[k].trim();} return ""; };
    return {
      subject:f(["Subject","SUBJECT","subject","Title"]),
      desc:f(["Description","DESCRIPTION","description","Comments","COMMENTS","Body","Notes"]),
      status:f(["Status","STATUS","status"]),
      dueDate:f(["Due Date","ACTIVITYDATE","DueDate","Due","Activity Date"]),
      createdAt:f(["Created Date","CREATEDDATE","CreatedDate","created_date","CREATEDDATE"]),
      owner:f(["Owner","OWNER","owner","Assigned To","Owner Name"]),
    };
  }).filter(t=>t.subject||t.desc).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,10);
}

function computeRiskScore(c, usageIndex, npsIndex, disputes) {
  const overduePct = Math.min(c.maxDaysOverdue/120,1)*100;
  const amountPct  = Math.min(Math.log10(Math.max(c.totalOutstanding,1))/Math.log10(500000),1)*100;
  const nps = getNpsSummary(c,npsIndex);
  const npsPct = nps ? Math.round((10-nps.latest.score)/10*100) : 50;
  const hasUsage = !!usageIndex[c.organizationUuid];
  const usagePct = hasUsage ? 20 : 100;
  const d = disputes?.[c.organizationUuid];
  const disputeMod = d ? d.risk_modifier : 0;
  const factors = [
    {name:"Days Overdue",raw:overduePct,weight:0.40},
    {name:"Amount",      raw:amountPct, weight:0.25},
    {name:"NPS Risk",    raw:npsPct,    weight:0.20, noData:!nps},
    {name:"No Usage",    raw:usagePct,  weight:0.15},
  ];
  const base = Math.round(factors.reduce((s,f)=>s+f.raw*f.weight,0));
  const total = Math.max(0, Math.min(100, base + disputeMod));
  if (d && d.dispute_category !== "insufficient_data") {
    factors.push({name:"Dispute",raw:Math.min(100, Math.max(0, 50 + disputeMod)),weight:0, noData:false});
  }
  return {total, factors};
}

function fmtUsage(s) {
  if (!s) return "No usage data.";
  return `Events:${s.totalEvents} Users:${s.uniqueUsers} First:${s.firstActive} Last:${s.lastActive} Features:${s.topUsecases.map(([k,v])=>`${k}(${v})`).join(",")} Actions:${s.topActions.map(([k,v])=>`${k}(${v})`).join(",")}`;
}
function fmtNps(s) {
  if (!s) return "No NPS data.";
  return `Avg:${s.avg}/10 Count:${s.count} Promoters:${s.promoters} Passives:${s.passives} Detractors:${s.detractors} Latest:${s.latest.score}/10 on ${s.latest.date}${s.latest.comment?` — "${s.latest.comment}"`:""}`;
}
function fmtTasks(tasks) {
  if (!tasks||!tasks.length) return "No tasks.";
  return tasks.map(t=>`[${t.status||"?"}] ${t.subject}${t.dueDate?` due:${t.dueDate}`:""}${t.desc?` — ${t.desc.slice(0,100)}`:""}${t.owner?` (${t.owner})`:""}`).join("\n");
}

async function callClaude({system,userMsg,mcpServers=[],tools=[],maxTokens=1500}) {
  const body={model:"claude-sonnet-4-20250514",max_tokens:maxTokens,system,messages:[{role:"user",content:userMsg}]};
  if (mcpServers.length) body.mcp_servers=mcpServers;
  if (tools.length) body.tools=tools;
  const res = await fetch("/api/claude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message||"Claude API error");
  return data.content.filter(b=>b.type==="text").map(b=>b.text).join("").trim();
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g,"").trim();
  const start = clean.search(/[{[]/);
  const ch = clean[start];
  const end = clean.lastIndexOf(ch==="{" ? "}" : "]");
  return JSON.parse(clean.slice(start, end+1));
}

async function fetchEmails(customer) {
  const nums = customer.invoices.map(i=>i.number).filter(Boolean).slice(0,5);
  const q = `(to:${GROUP_INBOX} OR from:${GROUP_INBOX}) AND ("${customer.name}"${nums.length?` OR ${nums.map(n=>`"${n}"`).join(" OR ")}`:"" })`;
  const res = await fetch("/api/gmail-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, maxResults: 5 }),
  });
  if (!res.ok) throw new Error("failed");
  const data = await res.json();
  return data.emails || [];
}

const DISPUTE_TONE = {
  enterprise_ap_delay:           "Tone: polite and patient. They intend to pay — just a gentle nudge to expedite the internal approval.",
  no_dispute_detected:           "Tone: friendly and professional. No blockers — just a standard reminder.",
  payment_method_failure:        "Tone: helpful and solution-focused. Offer a fresh payment link. Avoid blame.",
  auto_renewal_confusion:        "Tone: empathetic and educational. Clarify the auto-renewal terms calmly without being defensive.",
  seat_pricing_dispute:          "Tone: collaborative. Acknowledge the pricing conversation is in progress and offer to unblock payment while it resolves.",
  billing_error:                 "Tone: apologetic and action-oriented. Acknowledge the error, confirm it is being fixed, and provide a corrected timeline.",
  international_payment_barrier: "Tone: helpful and practical. Offer wire instructions or compliance docs proactively.",
  product_dissatisfaction:       "Tone: empathetic. Acknowledge their frustration, loop in Customer Success, and separate the relationship conversation from the payment obligation.",
  cancellation_dispute:          "Tone: firm but respectful. Reference the contract terms clearly. Avoid escalating language but be direct about the outstanding obligation.",
  insufficient_data:             "Tone: professional and neutral. Standard collections tone.",
};

function toneHint(dispute, npsSummary, usageSummary) {
  const parts = [];

  if (dispute && dispute.dispute_category !== "insufficient_data") {
    const tone = DISPUTE_TONE[dispute.dispute_category] || "";
    parts.push(`Dispute: ${dispute.dispute_category.replace(/_/g," ")} — ${dispute.summary}\n${tone}`);
  }

  if (npsSummary) {
    const avg = npsSummary.avg;
    if (avg >= 9) parts.push(`NPS context: Promoter (NPS ${avg}). They love the product — lead with appreciation for the relationship. Warm, personal tone. Treat the payment issue as a minor admin matter, not a conflict.`);
    else if (avg >= 7) parts.push(`NPS context: Passive (NPS ${avg}). Professionally warm — acknowledge the relationship without over-selling it.`);
    else parts.push(`NPS context: Detractor (NPS ${avg}). They are unhappy with the product. Be empathetic, avoid a pushy tone, and consider flagging for CSM review before sending.`);
  }

  if (usageSummary) {
    if (usageSummary.totalEvents > 100) parts.push(`Usage context: Heavy user (${usageSummary.totalEvents} events, ${usageSummary.uniqueUsers} users). They are clearly getting value — reference their active use as a positive signal.`);
    else if (usageSummary.totalEvents < 20) parts.push(`Usage context: Low usage (${usageSummary.totalEvents} events). There may be an adoption issue. Avoid leading with payment — consider offering a check-in or CSM intro alongside the payment request.`);
  }

  return parts.length ? "\n\n" + parts.join("\n\n") : "";
}

function senderHint(sender, am) {
  const arName = sender?.name || sender?.email?.split("@")[0] || "AR Team";
  const amName = am ? am.replace("@pandadoc.com","") : null;
  const cc = amName ? `CC: ${am}` : "";
  return `\n\nSender: Sign the email from ${arName} (Accounts Receivable).${cc ? ` ${cc} (Account Manager, for awareness).` : ""} Do NOT sign from the Account Manager.`;
}

async function generateRec({customer,emails,usageSummary,npsSummary,tasks,dispute,sender}) {
  const invs = customer.invoices.map(i=>`${i.number}: ${fmt(i.outstanding,customer.currency)} ${i.daysOverdue}d overdue`).join("\n");
  const ems  = emails.length ? emails.map(e=>`[${e.direction}] ${e.date} | ${e.subject} | ${e.snippet}`).join("\n") : "None";
  const text = await callClaude({
    system:"Collections intelligence analyst. Return ONLY raw JSON.",
    userMsg:`Customer: ${customer.name}\nAM: ${customer.accountManager||"?"}\nOutstanding: ${fmt(customer.totalOutstanding,customer.currency)} / ${customer.maxDaysOverdue}d overdue\n\nInvoices:\n${invs}\n\nEmails:\n${ems}\n\nTasks:\n${fmtTasks(tasks)}\n\nUsage: ${fmtUsage(usageSummary)}\nNPS: ${fmtNps(npsSummary)}${toneHint(dispute,npsSummary,usageSummary)}${senderHint(sender,customer.accountManager)}\n\nReturn exactly:\n{"riskScore":"High"|"Medium"|"Low","riskReasoning":"2-3 sentences","recommendedAction":"short title","actionReasoning":"1-2 sentences","playbook":[{"step":1,"action":"","timing":"","channel":"Email"|"Phone"|"Slack"|"Legal"},{"step":2,"action":"","timing":"","channel":"Email"|"Phone"|"Slack"|"Legal"},{"step":3,"action":"","timing":"","channel":"Email"|"Phone"|"Slack"|"Legal"}],"draftEmail":{"subject":"","body":""}}`,
    maxTokens:1500,
  });
  return parseJSON(text);
}

async function generateBulkEmail(customer, usageSummary, dispute, sender) {
  const invs = customer.invoices.map(i=>`${i.number}: ${fmt(i.outstanding,customer.currency)} ${i.daysOverdue}d overdue`).join("\n");
  const text = await callClaude({
    system:"Collections specialist. Return ONLY raw JSON.",
    userMsg:`Write a professional collections email.\nCustomer: ${customer.name}\nOutstanding: ${fmt(customer.totalOutstanding,customer.currency)} / ${customer.maxDaysOverdue}d overdue\nInvoices:\n${invs}\nUsage: ${fmtUsage(usageSummary)}${toneHint(dispute,null,usageSummary)}${senderHint(sender,customer.accountManager)}\nReturn: {"subject":"","body":""}`,
    maxTokens:600,
  });
  return parseJSON(text);
}

async function searchExecutives(customer) {
  const company = customer.accountName || customer.name;
  const text = await callClaude({
    system:"Business intelligence researcher. Return ONLY raw JSON.",
    userMsg:`Search LinkedIn and the web for finance/billing executives at "${company}".
Find people with titles like CFO, VP Finance, Controller, Head of AP, Accounts Payable Manager, Director of Finance, or similar.
Return: {"found":true,"executives":[{"name":"","title":"","linkedin_url":"","email_guess":"firstname.lastname@${customer.emailDomain||'company.com'}"}]}
If none found: {"found":false,"executives":[]}
Return up to 5 people, prioritize senior finance roles.`,
    tools:[{type:"web_search_20250305",name:"web_search"}],
    maxTokens:1200,
  });
  return parseJSON(text);
}

async function generateExecEmail(customer, exec, context) {
  const text = await callClaude({
    system:"Collections escalation specialist. Return ONLY raw JSON.",
    userMsg:`Write a professional but firm escalation email to a finance executive about overdue invoices.
Recipient: ${exec.name}, ${exec.title} at ${customer.accountName||customer.name}
Outstanding: ${fmt(customer.totalOutstanding, customer.currency)}
Days overdue: ${customer.maxDaysOverdue}
Invoice count: ${customer.invoices.length}
${context?`Context: ${context}`:""}

The tone should be respectful but convey urgency. Reference that previous collection attempts through normal channels have been unsuccessful.
Return: {"subject":"","body":""}`,
    maxTokens:800,
  });
  return parseJSON(text);
}

async function searchNews(customer) {
  const text = await callClaude({
    system:"Business intelligence analyst. Return ONLY raw JSON.",
    userMsg:`Search for recent news about "${customer.accountName||customer.name}" relevant to collections risk (bankruptcy, layoffs, funding, distress, lawsuits).\nReturn: {"found":true|false,"signals":[{"headline":"","summary":"","date":"","sentiment":"positive"|"negative"|"neutral","relevance":"high"|"medium"|"low"}],"collectionsImpact":"1-2 sentences"}\nIf nothing: {"found":false,"signals":[],"collectionsImpact":"No significant news found."}`,
    tools:[{type:"web_search_20250305",name:"web_search"}],
    maxTokens:1200,
  });
  return parseJSON(text);
}

// ── Shared components ─────────────────────────────────────────────────────────
function Spinner({size=16}) {
  return <div style={{width:size,height:size,border:"2px solid #2a3441",borderTop:`2px solid ${C.brand}`,borderRadius:"50%",animation:"spin 0.8s linear infinite",flexShrink:0}}/>;
}
function CopyBtn({text}) {
  const [ok,set]=useState(false);
  return <button onClick={()=>{navigator.clipboard.writeText(text);set(true);setTimeout(()=>set(false),2000);}} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:"4px 10px",fontSize:11,color:ok?C.brand:C.muted,cursor:"pointer"}}>{ok?"✓ Copied":"Copy"}</button>;
}
function CustName({c,size="md"}) {
  return (
    <span style={{display:"inline-flex",alignItems:"baseline",gap:6,flexWrap:"wrap"}}>
      <span style={{fontSize:size==="lg"?15:13,fontWeight:600,color:C.text}}>{c.name}</span>
      {c.accountName&&c.accountName!==c.name&&<span style={{fontSize:size==="lg"?12:11,color:C.faint}}>{c.accountName}</span>}
    </span>
  );
}
function NpsBadge({score,size="sm"}) {
  return <span style={{fontSize:size==="lg"?13:11,background:npsBg(score),border:`1px solid ${npsBorder(score)}`,color:npsColor(score),borderRadius:10,padding:size==="lg"?"4px 12px":"1px 7px",fontWeight:600,flexShrink:0}}>NPS {score}</span>;
}
function StatusBadge({status}) {
  const s=(status||"").toLowerCase();
  const col=s.includes("complet")||s.includes("done")?C.brand:s.includes("progress")?C.blue:C.yellow;
  return status?<span style={{fontSize:10,background:col+"22",border:`1px solid ${col}44`,color:col,borderRadius:8,padding:"1px 7px",fontWeight:600}}>{status}</span>:null;
}

const DISPUTE_META = {
  cancellation_dispute:          {label:"Cancellation",         color:C.red},
  payment_method_failure:        {label:"Payment Failure",      color:C.yellow},
  seat_pricing_dispute:          {label:"Pricing Dispute",      color:C.yellow},
  enterprise_ap_delay:           {label:"AP Delay",             color:C.blue},
  auto_renewal_confusion:        {label:"Auto-Renewal",         color:C.yellow},
  international_payment_barrier: {label:"Intl Payment",         color:C.yellow},
  product_dissatisfaction:       {label:"Product Issue",        color:C.red},
  billing_error:                 {label:"Billing Error",        color:C.yellow},
  no_dispute_detected:           {label:"No Dispute",           color:C.brand},
  insufficient_data:             {label:"Insufficient Data",    color:C.vfaint},
};

function DisputeBadge({d}) {
  if(!d) return null;
  const m=DISPUTE_META[d.dispute_category]||{label:d.dispute_category,color:C.faint};
  return (
    <span title={d.summary} style={{fontSize:10,background:m.color+"22",border:`1px solid ${m.color}44`,color:m.color,borderRadius:8,padding:"1px 7px",fontWeight:600,cursor:"default",whiteSpace:"nowrap"}}>
      {m.label}
    </span>
  );
}

// ── Drop Zone ─────────────────────────────────────────────────────────────────
function DropZone({label,sublabel,icon,loaded,onText,onClear}) {
  const [drag,setDrag]=useState(false);
  const ref=useRef();
  const readFile=f=>{const r=new FileReader();r.onload=e=>onText(e.target.result);r.readAsText(f);};
  return (
    <div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
      onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)readFile(f);}}
      onClick={()=>!loaded&&ref.current.click()}
      style={{background:drag?"#0e2a1a":loaded?"#0e1f17":C.surface,border:`2px dashed ${drag?C.brand:loaded?"#1a4a2e":C.border}`,borderRadius:12,padding:"16px 20px",cursor:loaded?"default":"pointer",display:"flex",alignItems:"center",gap:14,transition:"all 0.15s"}}>
      <div style={{fontSize:22,flexShrink:0}}>{loaded?"✅":icon}</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:600,color:loaded?C.brand:C.text}}>{loaded?`${label} loaded`:label}</div>
        <div style={{fontSize:11,color:C.faint,marginTop:2}}>{loaded?"Click × to remove":sublabel}</div>
      </div>
      {loaded
        ?<button onClick={e=>{e.stopPropagation();onClear();}} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"3px 9px",fontSize:12,color:C.faint,cursor:"pointer",flexShrink:0}}>×</button>
        :<span style={{fontSize:11,color:C.vfaint,flexShrink:0}}>Drop or click</span>}
      <input ref={ref} type="file" accept=".csv,.tsv,.txt" onChange={e=>{if(e.target.files[0])readFile(e.target.files[0]);e.target.value="";}} style={{display:"none"}}/>
    </div>
  );
}

// ── Landing Screen ────────────────────────────────────────────────────────────
function LandingScreen({onImport}) {
  const [inv,setInv]=useState(""); const [tasks,setTasks]=useState("");
  const [nps,setNps]=useState(""); const [usage,setUsage]=useState("");
  const [err,setErr]=useState(null); const [open,setOpen]=useState(false);
  const anyLoaded=inv||tasks||nps||usage;
  const sources=[
    {label:"Invoice Data",sublabel:"From Upflow — Customer Name, Invoice #, Days Overdue…",icon:"📄",val:inv,set:setInv},
    {label:"Salesforce Tasks",sublabel:"ORGANIZATION_UUID__C, Subject, Description, Status…",icon:"✅",val:tasks,set:setTasks},
    {label:"NPS Responses",sublabel:"end_user__properties__account_code, NPS score, Comment…",icon:"⭐",val:nps,set:setNps},
    {label:"Snowflake Usage Data",sublabel:"ACCOUNT_CODE, USER_ID, USAGE_DATE, LEVEL_1, KEY_ACTION…",icon:"📊",val:usage,set:setUsage},
  ];
  function go() {
    try {
      let customers=null,usageIndex=null,npsIndex=null,tasksIndex=null;
      if (inv.trim())   { customers=buildCustomers(parseCSV(inv)); if(!customers.length) throw new Error("No customer rows found"); }
      if (usage.trim()) usageIndex=buildUsageIndex(parseCSV(usage));
      if (nps.trim())   npsIndex=buildNpsIndex(parseCSV(nps));
      if (tasks.trim()) tasksIndex=buildTasksIndex(parseCSV(tasks));
      onImport(customers,usageIndex,npsIndex,tasksIndex);
    } catch(e) { setErr(e.message); }
  }
  const features=[
    {icon:"🎯",title:"Risk Scoring",desc:"AI ranks accounts by likelihood to churn or default"},
    {icon:"📧",title:"Draft Emails",desc:"One-click outreach tailored to each customer's history"},
    {icon:"📡",title:"Signal Intelligence",desc:"Gmail threads, NPS scores, product usage in one view"},
    {icon:"🗞️",title:"News Monitoring",desc:"Live web signals on bankruptcy, layoffs, and distress"},
  ];
  return (
    <div style={{flex:1,overflowY:"auto",background:C.bg}}>
      <div style={{padding:"64px 40px 48px",background:"radial-gradient(ellipse 80% 60% at 50% -10%, #0e2a1a 0%, transparent 70%)",textAlign:"center",borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:"inline-flex",alignItems:"center",gap:12,marginBottom:28,background:"#0e1f17",border:"1px solid #1a3d28",borderRadius:14,padding:"10px 20px"}}>
          <span style={{fontSize:22,lineHeight:1}}>🐼</span>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-start",lineHeight:1}}>
            <span style={{fontSize:10,fontWeight:600,color:C.brand,letterSpacing:2,textTransform:"uppercase"}}>PandaDoc</span>
            <span style={{fontSize:16,fontWeight:800,color:C.text,letterSpacing:0.5}}>AR360</span>
          </div>
          <span style={{fontSize:10,background:C.brandGlow,border:`1px solid ${C.brand}44`,color:C.brand,borderRadius:6,padding:"2px 7px",fontWeight:600,marginLeft:4}}>BETA</span>
        </div>
        <h1 style={{fontSize:42,fontWeight:800,color:C.text,margin:"0 0 16px",lineHeight:1.15,letterSpacing:-1}}>
          Full visibility into your<br/>
          <span style={{background:`linear-gradient(135deg,${C.brand},${C.greenLight})`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>accounts receivable</span>
        </h1>
        <p style={{fontSize:16,color:C.muted,maxWidth:480,margin:"0 auto 36px",lineHeight:1.7}}>
          AI-powered risk scoring, automated outreach, and real-time signals — so your team knows exactly who to call and what to say.
        </p>
        {!open
          ?<button onClick={()=>setOpen(true)} style={{background:`linear-gradient(135deg,${C.brand},${C.brandDark})`,border:"none",borderRadius:12,padding:"14px 32px",fontSize:15,fontWeight:700,color:"#fff",cursor:"pointer",boxShadow:`0 0 32px ${C.brandGlow}`}}>Load your data →</button>
          :<div style={{maxWidth:560,margin:"0 auto",textAlign:"left"}}>
            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
              {sources.map(s=><DropZone key={s.label} label={s.label} sublabel={s.sublabel} icon={s.icon} loaded={!!s.val} onText={s.set} onClear={()=>s.set("")}/>)}
            </div>
            {err&&<div style={{fontSize:12,color:C.red,marginBottom:10}}>⚠ {err}</div>}
            <button onClick={go} disabled={!anyLoaded} style={{width:"100%",background:anyLoaded?`linear-gradient(135deg,${C.brand},${C.brandDark})`:C.surface,border:"none",borderRadius:12,padding:14,fontSize:15,fontWeight:700,color:anyLoaded?"#fff":C.vfaint,cursor:anyLoaded?"pointer":"not-allowed"}}>
              {anyLoaded?"Analyze →":"Drop in at least one file to continue"}
            </button>
          </div>
        }
      </div>
      <div style={{padding:"48px 40px",maxWidth:860,margin:"0 auto"}}>
        <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:2,color:C.faint,textAlign:"center",marginBottom:28}}>What's inside</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:16}}>
          {features.map(f=>(
            <div key={f.title} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"20px 18px"}}>
              <div style={{fontSize:24,marginBottom:10}}>{f.icon}</div>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:6}}>{f.title}</div>
              <div style={{fontSize:12,color:C.faint,lineHeight:1.6}}>{f.desc}</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:40,padding:"18px 24px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,display:"flex",alignItems:"center",flexWrap:"wrap"}}>
          <div style={{fontSize:11,color:C.faint,fontWeight:600,textTransform:"uppercase",letterSpacing:1,marginRight:20,flexShrink:0}}>Connects with</div>
          {["Upflow","Salesforce","Snowflake","Gmail","Web Search"].map((s,i,arr)=>(
            <span key={s} style={{fontSize:13,color:C.muted,padding:"0 14px",borderRight:i<arr.length-1?`1px solid ${C.border}`:"none"}}>{s}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Stats Bar ─────────────────────────────────────────────────────────────────
function StatsBar({customers,usageIndex,npsIndex,tasksIndex}) {
  const totalAR   = customers.reduce((s,c)=>s+c.totalOutstanding,0);
  const over90    = customers.filter(c=>c.maxDaysOverdue>90).length;
  const over60    = customers.filter(c=>c.maxDaysOverdue>60).length;
  const withUsage = customers.filter(c=>!!usageIndex[c.organizationUuid]).length;
  const withTasks = tasksIndex?customers.filter(c=>getTasks(c,tasksIndex).length>0).length:null;
  const npsScores = customers.map(c=>getNpsSummary(c,npsIndex)).filter(Boolean).map(s=>s.avg);
  const avgNps    = npsScores.length?(npsScores.reduce((a,b)=>a+b,0)/npsScores.length).toFixed(1):null;
  const stats=[
    {label:"Total AR at Risk", value:fmt(totalAR),                       color:C.red},
    {label:"90+ Days Overdue", value:over90,                             color:C.red},
    {label:"60+ Days Overdue", value:over60,                             color:C.yellow},
    {label:"Customers",        value:customers.length,                   color:C.text},
    {label:"With Usage",       value:`${withUsage}/${customers.length}`, color:C.brand},
    ...(avgNps?[{label:"Avg NPS",value:avgNps,color:npsColor(parseFloat(avgNps))}]:[]),
    ...(withTasks!=null?[{label:"With Tasks",value:`${withTasks}/${customers.length}`,color:C.brand}]:[]),
  ];
  return (
    <div style={{display:"flex",borderBottom:`1px solid ${C.border}`,background:"#0a0e14",flexShrink:0,flexWrap:"wrap"}}>
      {stats.map((s,i)=>(
        <div key={i} style={{flex:1,minWidth:100,padding:"10px 14px",borderRight:i<stats.length-1?`1px solid ${C.border}`:"none"}}>
          <div style={{fontSize:10,color:C.faint,marginBottom:3}}>{s.label}</div>
          <div style={{fontSize:17,fontWeight:800,color:s.color}}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── AM Breakdown ──────────────────────────────────────────────────────────────
function AMBreakdown({customers}) {
  const map={};
  for (const c of customers) {
    const am=c.accountManager||"Unassigned";
    if(!map[am]) map[am]={am,total:0,count:0,maxOverdue:0};
    map[am].total+=c.totalOutstanding; map[am].count+=1;
    map[am].maxOverdue=Math.max(map[am].maxOverdue,c.maxDaysOverdue);
  }
  const rows=Object.values(map).sort((a,b)=>b.total-a.total);
  const grand=rows.reduce((s,r)=>s+r.total,0);
  return (
    <div style={{flex:1,overflowY:"auto",padding:20}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:4}}>Account Manager Exposure</div>
      <div style={{fontSize:12,color:C.faint,marginBottom:16}}>Total overdue AR by AM</div>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead>
            <tr style={{borderBottom:`1px solid ${C.border}`,background:C.surfaceDim}}>
              {["Account Manager","Customers","Total AR","% of Total","Max Overdue","Level"].map(h=>(
                <th key={h} style={{padding:"10px 14px",textAlign:"left",color:C.faint,fontWeight:600,fontSize:11,textTransform:"uppercase"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r,i)=>{
              const pct=((r.total/grand)*100).toFixed(1);
              const col=r.maxOverdue>90?C.red:r.maxOverdue>60?C.yellow:C.brand;
              return (
                <tr key={i} style={{borderBottom:`1px solid ${C.borderDim}`}}>
                  <td style={{padding:"10px 14px",color:C.text,fontWeight:500}}>{r.am.replace("@pandadoc.com","")}</td>
                  <td style={{padding:"10px 14px",color:C.muted}}>{r.count}</td>
                  <td style={{padding:"10px 14px",color:C.text,fontWeight:700}}>{fmt(r.total)}</td>
                  <td style={{padding:"10px 14px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{flex:1,height:6,background:C.border,borderRadius:3,overflow:"hidden"}}><div style={{width:`${pct}%`,height:"100%",background:C.brand,borderRadius:3}}/></div>
                      <span style={{fontSize:11,color:C.faint,width:34}}>{pct}%</span>
                    </div>
                  </td>
                  <td style={{padding:"10px 14px",color:col}}>{r.maxOverdue}d</td>
                  <td style={{padding:"10px 14px"}}><span style={{fontSize:11,background:col+"22",border:`1px solid ${col}44`,color:col,borderRadius:10,padding:"2px 8px"}}>{r.maxOverdue>90?"Critical":r.maxOverdue>60?"High":"Medium"}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Hit List ──────────────────────────────────────────────────────────────────
function HitList({customers,usageIndex,npsIndex,tasksIndex,onSelect,disputes,user}) {
  const [emails,setEmails]=useState({});
  const [generating,setGenerating]=useState(false);
  const [progress,setProgress]=useState(0);
  const ranked=[...customers].map(c=>({...c,_risk:computeRiskScore(c,usageIndex,npsIndex,disputes)})).sort((a,b)=>b._risk.total-a._risk.total).slice(0,10);

  async function genAll() {
    setGenerating(true);setProgress(0);
    const res={};
    for(let i=0;i<ranked.length;i++){
      const c=ranked[i];
      try{res[c.name]=await generateBulkEmail(c,getUsageSummary(c,usageIndex),disputes?.[c.organizationUuid],user);}catch(e){res[c.name]={subject:"Error",body:e.message};}
      setProgress(i+1);setEmails({...res});
    }
    setGenerating(false);
  }

  function exportCSV() {
    const rows=ranked.map(c=>{const e=emails[c.name];return [c.name,c.accountManager,fmt(c.totalOutstanding,c.currency),c.maxDaysOverdue,c._risk.total,e?.subject||"",(e?.body||"").replace(/\n/g," ")].map(v=>`"${v}"`).join(",");});
    const csv=["Customer,AM,Outstanding,Days Overdue,Risk Score,Email Subject,Email Body",...rows].join("\n");
    const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);a.download="ar360_hit_list.csv";a.click();
  }

  const allDone=Object.keys(emails).length===ranked.length;
  return (
    <div style={{flex:1,overflowY:"auto",padding:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
        <div>
          <div style={{fontSize:15,fontWeight:700,marginBottom:4}}>Today's Hit List</div>
          <div style={{fontSize:12,color:C.faint}}>Top 10 ranked by aggregate risk score</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          {allDone&&<button onClick={exportCSV} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:600,color:C.brand,cursor:"pointer"}}>↓ Export CSV</button>}
          <button onClick={genAll} disabled={generating} style={{background:generating?C.surface:`linear-gradient(135deg,${C.brand},${C.brandDark})`,border:"none",borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:600,color:generating?C.vfaint:"#fff",cursor:generating?"not-allowed":"pointer",display:"flex",alignItems:"center",gap:8}}>
            {generating?<><Spinner size={12}/>Generating {progress}/{ranked.length}…</>:"⚡ Generate all emails"}
          </button>
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {ranked.map((c,i)=>{
          const email=emails[c.name];
          const nps=getNpsSummary(c,npsIndex);
          const {total,factors}=c._risk;
          const sc=scoreColor(total);
          return (
            <div key={i} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
              <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px"}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:i<3?`linear-gradient(135deg,${C.brand},${C.brandDark})`:C.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800,flexShrink:0,color:i<3?"#fff":C.faint}}>{i+1}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                    <CustName c={c}/>
                    {nps&&<NpsBadge score={nps.avg}/>}
                  </div>
                  <div style={{fontSize:11,color:C.faint}}>{(c.accountManager||"Unassigned").replace("@pandadoc.com","")} · {c.invoices.length} inv · {c.maxDaysOverdue}d overdue</div>
                </div>
                <div style={{textAlign:"center",flexShrink:0,background:C.surfaceDim,border:`1px solid ${sc}44`,borderRadius:8,padding:"5px 10px"}}>
                  <div style={{fontSize:10,color:C.faint,marginBottom:1}}>Risk</div>
                  <div style={{fontSize:18,fontWeight:800,color:sc,lineHeight:1}}>{total}</div>
                  <div style={{fontSize:9,fontWeight:600,color:sc,marginTop:1}}>{total>=70?"High":total>=45?"Med":"Low"}</div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontSize:14,fontWeight:800,color:C.text}}>{fmt(c.totalOutstanding,c.currency)}</div>
                </div>
                <button onClick={()=>onSelect(c)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"4px 10px",fontSize:11,color:C.brand,cursor:"pointer",flexShrink:0}}>Analyze →</button>
              </div>
              <div style={{display:"flex",borderTop:`1px solid ${C.border}`}}>
                {factors.map((f,fi)=>{
                  const fc=scoreColor(f.raw);
                  return (
                    <div key={fi} style={{flex:1,padding:"6px 10px",borderRight:fi<factors.length-1?`1px solid ${C.border}`:"none",background:C.surfaceDim}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                        <span style={{fontSize:9,color:C.vfaint,textTransform:"uppercase"}}>{f.name}</span>
                        <span style={{fontSize:10,fontWeight:700,color:f.noData?C.vfaint:fc}}>{f.noData?"—":Math.round(f.raw)}</span>
                      </div>
                      <div style={{height:3,background:C.border,borderRadius:2,overflow:"hidden"}}>
                        <div style={{width:`${f.noData?50:f.raw}%`,height:"100%",background:f.noData?"#374151":fc,opacity:f.noData?0.4:1}}/>
                      </div>
                    </div>
                  );
                })}
              </div>
              {email&&(
                <div style={{borderTop:`1px solid ${C.border}`,padding:"10px 16px",background:C.surfaceDim}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                    <div style={{fontSize:11,fontWeight:600,color:C.brand}}>📧 {email.subject}</div>
                    <CopyBtn text={`Subject: ${email.subject}\n\n${email.body}`}/>
                  </div>
                  <div style={{fontSize:12,color:C.faint,lineHeight:1.6,whiteSpace:"pre-wrap",maxHeight:80,overflow:"hidden",maskImage:"linear-gradient(to bottom,#64748b 60%,transparent)"}}>{email.body}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Customer Detail ───────────────────────────────────────────────────────────
function CustomerDetail({selected,usageIndex,npsIndex,tasksIndex,onBack,dispute,user}) {
  const [rec,setRec]=useState(null); const [recErr,setRecErr]=useState(null); const [recLoading,setRecLoading]=useState(false);
  const [emails,setEmails]=useState([]); const [emailLoading,setEmailLoading]=useState(false); const [emailErr,setEmailErr]=useState(null);
  const [news,setNews]=useState(null); const [newsLoading,setNewsLoading]=useState(false); const [newsErr,setNewsErr]=useState(null);
  const [execs,setExecs]=useState(null); const [execsLoading,setExecsLoading]=useState(false); const [execsErr,setExecsErr]=useState(null);
  const [execEmails,setExecEmails]=useState({}); const [execEmailLoading,setExecEmailLoading]=useState({});
  const [tab,setTab]=useState("recommendation");

  const usageSummary=getUsageSummary(selected,usageIndex);
  const npsSummary=getNpsSummary(selected,npsIndex);
  const tasks=getTasks(selected,tasksIndex);

  async function doGenerate() {
    setRecLoading(true);setRecErr(null);
    try{setRec(await generateRec({customer:selected,emails,usageSummary,npsSummary,tasks,dispute,sender:user}));}
    catch(e){setRecErr(e.message);}finally{setRecLoading(false);}
  }
  async function doSearchEmails() {
    setEmailLoading(true);setEmailErr(null);
    try{setEmails(await fetchEmails(selected));}
    catch(e){setEmailErr(e.message==="timeout"?"timed out":"failed");}finally{setEmailLoading(false);}
  }
  async function doSearchNews() {
    setNewsLoading(true);setNewsErr(null);
    try{setNews(await searchNews(selected));}
    catch(e){setNewsErr(e.message);}finally{setNewsLoading(false);}
  }
  async function doSearchExecs() {
    setExecsLoading(true);setExecsErr(null);
    try{setExecs(await searchExecutives(selected));}
    catch(e){setExecsErr(e.message);}finally{setExecsLoading(false);}
  }
  async function doGenExecEmail(exec,i) {
    setExecEmailLoading(p=>({...p,[i]:true}));
    try{
      const context=dispute?`Dispute: ${dispute.dispute_category.replace(/_/g," ")} — ${dispute.summary}`:"";
      const email=await generateExecEmail(selected,exec,context);
      setExecEmails(p=>({...p,[i]:email}));
    }catch{}finally{setExecEmailLoading(p=>({...p,[i]:false}));}
  }

  const tabs=["recommendation","playbook","email","invoices","tasks","usage","nps","executives","news"];
  const tabLabel=t=>({recommendation:"Recommendation",playbook:"Playbook",email:"Draft Email",invoices:"Invoices",tasks:`Tasks${tasks.length?` (${tasks.length})`:""}`,usage:"Usage",nps:`NPS${npsSummary?` (${npsSummary.count})`:""}`,executives:"Executives",news:"🔍 News"}[t]);

  return (
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {/* Header */}
      <div style={{padding:"12px 20px",borderBottom:`1px solid ${C.border}`,background:C.surfaceDim,display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
        <button onClick={onBack} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"3px 10px",fontSize:12,color:C.faint,cursor:"pointer"}}>← Back</button>
        <div style={{flex:1}}>
          <CustName c={selected} size="lg"/>
          <div style={{fontSize:11,color:C.faint,display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginTop:2}}>
            <span>{fmt(selected.totalOutstanding,selected.currency)} · {selected.invoices.length} inv</span>
            {selected.maxDaysOverdue>0&&<span style={{color:C.red}}>· {selected.maxDaysOverdue}d overdue</span>}
            {selected.accountManager&&<span>· {selected.accountManager.replace("@pandadoc.com","")}</span>}
            {usageSummary&&<span style={{color:C.brand}}>· usage ✓</span>}
            {tasks.length>0&&<span style={{color:C.brand}}>· {tasks.length} tasks</span>}
            <DisputeBadge d={dispute}/>
            {npsSummary&&<NpsBadge score={npsSummary.avg}/>}
          </div>
        </div>
      </div>

      {/* Dispute Classification */}
      {dispute&&dispute.dispute_category!=="insufficient_data"&&(
        <div style={{margin:"0 20px",marginTop:12,padding:"10px 14px",background:C.surface,border:`1px solid ${(DISPUTE_META[dispute.dispute_category]||{color:C.faint}).color}44`,borderRadius:10,display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
          <DisputeBadge d={dispute}/>
          <div style={{flex:1,fontSize:12,color:C.muted,lineHeight:1.5}}>{dispute.summary}</div>
          <div style={{display:"flex",gap:10,flexShrink:0,fontSize:11}}>
            <div style={{textAlign:"center"}}><div style={{color:C.faint,marginBottom:1}}>Action</div><div style={{color:C.text,fontWeight:600}}>{(dispute.recommended_action||"").replace(/_/g," ")}</div></div>
            <div style={{textAlign:"center"}}><div style={{color:C.faint,marginBottom:1}}>Collect</div><div style={{color:dispute.collection_probability==="high"?C.brand:dispute.collection_probability==="low"?C.red:C.yellow,fontWeight:600}}>{dispute.collection_probability}</div></div>
            <div style={{textAlign:"center"}}><div style={{color:C.faint,marginBottom:1}}>Risk Δ</div><div style={{color:dispute.risk_modifier>0?C.red:dispute.risk_modifier<0?C.brand:C.muted,fontWeight:600}}>{dispute.risk_modifier>0?"+":""}{dispute.risk_modifier}</div></div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{display:"flex",borderBottom:`1px solid ${C.border}`,background:C.surfaceDim,overflowX:"auto",flexShrink:0,marginTop:dispute&&dispute.dispute_category!=="insufficient_data"?8:0}}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{background:"none",border:"none",borderBottom:tab===t?`2px solid ${C.brand}`:"2px solid transparent",padding:"10px 14px",fontSize:13,color:tab===t?C.greenLight:C.faint,cursor:"pointer",whiteSpace:"nowrap"}}>
            {tabLabel(t)}
          </button>
        ))}
      </div>

      <div style={{flex:1,overflowY:"auto",padding:20}}>

        {/* Recommendation */}
        {tab==="recommendation"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {!rec&&!recLoading&&(
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,padding:"30px 0"}}>
                <div style={{fontSize:13,color:C.faint,textAlign:"center"}}>Review the tabs below, then generate when ready.</div>
                <button onClick={doGenerate} style={{background:`linear-gradient(135deg,${C.brand},${C.brandDark})`,border:"none",borderRadius:8,padding:"9px 22px",fontSize:13,fontWeight:600,color:"#fff",cursor:"pointer"}}>⚡ Generate risk score & playbook</button>
              </div>
            )}
            {recLoading&&<div style={{display:"flex",alignItems:"center",gap:10,fontSize:13,color:C.faint,padding:"20px 0"}}><Spinner/>Generating…</div>}
            {recErr&&<div style={{padding:"12px 14px",background:"#2a1515",border:"1px solid #7f1d1d",borderRadius:10,fontSize:13,color:"#fca5a5"}}>⚠ {recErr}</div>}
            {rec&&(
              <>
                <div style={{padding:"14px 16px",background:riskBg(rec.riskScore),border:`1px solid ${riskBorder(rec.riskScore)}`,borderRadius:12,display:"flex",gap:16,alignItems:"flex-start"}}>
                  <div style={{textAlign:"center",flexShrink:0}}>
                    <div style={{fontSize:10,color:C.faint,textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Risk</div>
                    <div style={{fontSize:22,fontWeight:800,color:riskColor(rec.riskScore)}}>{rec.riskScore}</div>
                  </div>
                  <div style={{borderLeft:`1px solid ${C.border}`,paddingLeft:16}}>
                    <div style={{fontSize:13,fontWeight:600,color:C.text,marginBottom:4}}>→ {rec.recommendedAction}</div>
                    <div style={{fontSize:12,color:C.muted,lineHeight:1.6}}>{rec.riskReasoning}</div>
                  </div>
                </div>
                <div style={{fontSize:13,color:C.text,lineHeight:1.7,background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px"}}>{rec.actionReasoning}</div>
                <button onClick={doGenerate} disabled={recLoading} style={{alignSelf:"flex-start",background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"4px 12px",fontSize:11,color:C.faint,cursor:"pointer"}}>↻ Regenerate</button>
              </>
            )}
            <div style={{fontSize:12,fontWeight:600,color:C.faint,textTransform:"uppercase",letterSpacing:1,marginTop:8,display:"flex",alignItems:"center",gap:8}}>
              Email signals
              {emailLoading?<><Spinner size={12}/><span style={{fontWeight:400,textTransform:"none",letterSpacing:0}}>scanning…</span></>
              :emails.length>0?<span>({emails.length} found)</span>
              :emailErr?<><span style={{color:C.red,fontWeight:400,textTransform:"none",letterSpacing:0}}>{emailErr}</span><button onClick={doSearchEmails} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"2px 8px",fontSize:11,color:C.brand,cursor:"pointer"}}>Retry</button></>
              :<button onClick={doSearchEmails} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"2px 8px",fontSize:11,color:C.brand,cursor:"pointer"}}>Search inbox</button>}
            </div>
            {emails.map((e,i)=>(
              <div key={i} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px"}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <div style={{fontSize:12,fontWeight:600,color:e.direction==="inbound"?C.brand:C.yellow}}>{e.direction==="inbound"?"← Inbound":"→ Outbound"}</div>
                  <div style={{fontSize:11,color:C.faint}}>{e.date}</div>
                </div>
                <div style={{fontSize:13,color:C.text,marginBottom:3}}>{e.subject}</div>
                <div style={{fontSize:12,color:C.faint}}>{e.snippet}</div>
              </div>
            ))}
          </div>
        )}

        {/* Playbook */}
        {tab==="playbook"&&(
          !rec
          ?<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,padding:"30px 0"}}>
            <div style={{fontSize:13,color:C.faint}}>Generate a recommendation first.</div>
            <button onClick={()=>setTab("recommendation")} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 16px",fontSize:13,color:C.brand,cursor:"pointer"}}>← Back to Recommendation</button>
          </div>
          :<div style={{display:"flex",flexDirection:"column",gap:10}}>
            {rec.playbook?.map((step,i)=>(
              <div key={i} style={{display:"flex",gap:14,background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",alignItems:"flex-start"}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:`linear-gradient(135deg,${C.brand},${C.brandDark})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,flexShrink:0}}>{step.step}</div>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <div style={{fontSize:13,fontWeight:600,color:C.text}}>{step.action}</div>
                    <div style={{fontSize:11,background:chanColor(step.channel)+"22",border:`1px solid ${chanColor(step.channel)}44`,color:chanColor(step.channel),borderRadius:10,padding:"1px 8px"}}>{step.channel}</div>
                  </div>
                  <div style={{fontSize:12,color:C.faint}}>⏱ {step.timing}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Draft Email */}
        {tab==="email"&&(
          !rec
          ?<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,padding:"30px 0"}}>
            <div style={{fontSize:13,color:C.faint}}>Generate a recommendation first.</div>
            <button onClick={()=>setTab("recommendation")} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 16px",fontSize:13,color:C.brand,cursor:"pointer"}}>← Back to Recommendation</button>
          </div>
          :rec.draftEmail&&(
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
              <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:11,color:C.faint,marginBottom:2}}>Subject</div>
                  <div style={{fontSize:13,fontWeight:600,color:C.text}}>{rec.draftEmail.subject}</div>
                </div>
                <CopyBtn text={`Subject: ${rec.draftEmail.subject}\n\n${rec.draftEmail.body}`}/>
              </div>
              <div style={{padding:16,fontSize:13,color:C.text,lineHeight:1.8,whiteSpace:"pre-wrap"}}>{rec.draftEmail.body}</div>
            </div>
          )
        )}

        {/* Invoices */}
        {tab==="invoices"&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,overflow:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${C.border}`}}>
                  {["Invoice","Issued","Due","Outstanding","Overdue","State","Workflow"].map(h=>(
                    <th key={h} style={{padding:"8px 12px",textAlign:"left",color:C.faint,fontWeight:600,whiteSpace:"nowrap"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selected.invoices.map((inv,i)=>(
                  <tr key={i} style={{borderBottom:`1px solid ${C.borderDim}`}}>
                    <td style={{padding:"8px 12px",color:C.greenLight}}>{inv.number}</td>
                    <td style={{padding:"8px 12px",color:C.muted}}>{inv.issueDate}</td>
                    <td style={{padding:"8px 12px",color:C.muted}}>{inv.dueDate}</td>
                    <td style={{padding:"8px 12px",color:C.text,fontWeight:600}}>{fmt(inv.outstanding,selected.currency)}</td>
                    <td style={{padding:"8px 12px",color:inv.daysOverdue>60?C.red:inv.daysOverdue>0?C.yellow:C.brand}}>{inv.daysOverdue>0?`${inv.daysOverdue}d`:"Current"}</td>
                    <td style={{padding:"8px 12px",color:C.muted}}>{inv.state}</td>
                    <td style={{padding:"8px 12px",color:C.faint}}>{inv.workflow}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Tasks */}
        {tab==="tasks"&&(
          tasks.length===0
          ?<div style={{fontSize:13,color:C.vfaint,textAlign:"center",padding:"30px 0"}}>
            No tasks found for this customer.
            {tasksIndex&&(
              <div style={{marginTop:14,fontSize:11,textAlign:"left",background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px",display:"flex",flexDirection:"column",gap:6}}>
                <div><span style={{color:C.faint}}>Detected ID column: </span><span style={{color:tasksIndex.idCol?C.brand:C.red,fontFamily:"monospace"}}>{tasksIndex.idCol||"(none)"}</span></div>
                <div><span style={{color:C.faint}}>Customer Org UUID: </span><span style={{color:C.text,fontFamily:"monospace"}}>{selected.organizationUuid||"(none)"}</span></div>
                <div><span style={{color:C.faint}}>Sample IDs in file: </span><span style={{color:C.text,fontFamily:"monospace"}}>{(tasksIndex.sampleIds||[]).slice(0,5).join(", ")||"(none)"}</span></div>
                <div><span style={{color:C.faint}}>All columns: </span><span style={{color:C.muted,fontFamily:"monospace",fontSize:10}}>{(tasksIndex.cols||[]).join(", ")}</span></div>
              </div>
            )}
          </div>
          :<div style={{display:"flex",flexDirection:"column",gap:10}}>
            {tasks.map((t,i)=>(
              <div key={i} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
                <div style={{padding:"12px 16px 10px",borderBottom:t.desc?`1px solid ${C.borderDim}`:"none",display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
                  <div style={{fontSize:14,fontWeight:700,color:C.text,lineHeight:1.4,flex:1}}>{t.subject||"(no subject)"}</div>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4,flexShrink:0}}>
                    {t.status&&<StatusBadge status={t.status}/>}
                    {t.dueDate&&<span style={{fontSize:11,color:C.yellow}}>Due {t.dueDate}</span>}
                  </div>
                </div>
                {t.desc&&<div style={{padding:"10px 16px",background:C.surfaceDim,fontSize:13,color:C.muted,lineHeight:1.75,whiteSpace:"pre-wrap"}}>{t.desc}</div>}
                {(t.owner||t.createdAt)&&(
                  <div style={{padding:"7px 16px",borderTop:`1px solid ${C.borderDim}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    {t.owner?<span style={{fontSize:11,color:C.vfaint}}>👤 {t.owner}</span>:<span/>}
                    {t.createdAt&&<span style={{fontSize:11,color:C.vfaint}}>{t.createdAt}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Usage */}
        {tab==="usage"&&(
          !usageSummary
          ?<div style={{fontSize:13,color:C.vfaint}}>No usage data for this customer.</div>
          :<div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              {[["Total Events",usageSummary.totalEvents],["Unique Users",usageSummary.uniqueUsers],["First Active",usageSummary.firstActive],["Last Active",usageSummary.lastActive]].map(([l,v])=>(
                <div key={l} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",flex:1,minWidth:120}}>
                  <div style={{fontSize:11,color:C.faint,marginBottom:4}}>{l}</div>
                  <div style={{fontSize:16,fontWeight:700,color:C.text}}>{v}</div>
                </div>
              ))}
            </div>
            {[["Top Feature Areas",usageSummary.topUsecases],["Top Actions",usageSummary.topActions]].map(([title,items])=>(
              <div key={title} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{fontSize:12,fontWeight:600,color:C.faint,marginBottom:10,textTransform:"uppercase",letterSpacing:1}}>{title}</div>
                {items.map(([name,count])=>(
                  <div key={name} style={{display:"flex",justifyContent:"space-between",fontSize:13,color:C.text,marginBottom:6}}>
                    <span>{name}</span><span style={{color:C.brand,fontWeight:600}}>{count}x</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* NPS */}
        {tab==="nps"&&(
          !npsSummary
          ?<div style={{fontSize:13,color:C.vfaint,padding:"20px 0"}}>
            <div style={{marginBottom:12,textAlign:"center"}}>No NPS data matched.</div>
            <div style={{fontSize:11,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px",display:"flex",flexDirection:"column",gap:6}}>
              <div style={{fontSize:12,fontWeight:600,color:C.faint,marginBottom:2}}>🔍 Lookup debug</div>
              <div><span style={{color:C.faint}}>Org UUID: </span><span style={{fontFamily:"monospace",color:npsIndex?.[selected.organizationUuid]?C.brand:C.red}}>{selected.organizationUuid||"(none)"} — {npsIndex?.[selected.organizationUuid]?"✓ FOUND":"✗ not found"}</span></div>
              <div><span style={{color:C.faint}}>Email domain: </span><span style={{fontFamily:"monospace",color:npsIndex?.[selected.emailDomain]?C.brand:C.red}}>{selected.emailDomain||"(none)"} — {npsIndex?.[selected.emailDomain]?"✓ FOUND":"✗ not found"}</span></div>
              <div style={{borderTop:`1px solid ${C.border}`,paddingTop:6,marginTop:2}}>
                {npsIndex?.[selected.organizationUuid]&&(
                  <>
                    <div style={{color:C.brand,marginBottom:4}}>✓ {npsIndex[selected.organizationUuid].length} rows found — columns in first row:</div>
                    {Object.keys(npsIndex[selected.organizationUuid][0]||{}).map(k=>(
                      <div key={k} style={{fontFamily:"monospace",color:C.muted,fontSize:10}}>{k}: {String(npsIndex[selected.organizationUuid][0][k]).slice(0,40)}</div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
          :<div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              {[{l:"Avg Score",v:npsSummary.avg,col:npsColor(npsSummary.avg)},{l:"Responses",v:npsSummary.count,col:C.text},{l:"Promoters",v:npsSummary.promoters,col:C.brand},{l:"Passives",v:npsSummary.passives,col:C.yellow},{l:"Detractors",v:npsSummary.detractors,col:C.red}].map(({l,v,col})=>(
                <div key={l} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",flex:1,minWidth:80,textAlign:"center"}}>
                  <div style={{fontSize:11,color:C.faint,marginBottom:4}}>{l}</div>
                  <div style={{fontSize:20,fontWeight:800,color:col}}>{v}</div>
                </div>
              ))}
            </div>
            {npsSummary.count>0&&(()=>{
              const total=npsSummary.count;
              const pPct=(npsSummary.promoters/total*100).toFixed(1);
              const paPct=(npsSummary.passives/total*100).toFixed(1);
              const dPct=(npsSummary.detractors/total*100).toFixed(1);
              return (
                <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 16px"}}>
                  <div style={{fontSize:11,fontWeight:600,color:C.faint,textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>Response Breakdown</div>
                  <div style={{display:"flex",height:10,borderRadius:6,overflow:"hidden",gap:2}}>
                    {npsSummary.promoters>0&&<div style={{flex:npsSummary.promoters,background:C.brand}}/>}
                    {npsSummary.passives>0&&<div style={{flex:npsSummary.passives,background:C.yellow}}/>}
                    {npsSummary.detractors>0&&<div style={{flex:npsSummary.detractors,background:C.red}}/>}
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:8}}>
                    {[[`Promoters ${pPct}%`,C.brand],[`Passives ${paPct}%`,C.yellow],[`Detractors ${dPct}%`,C.red]].map(([label,col])=>(
                      <div key={label} style={{display:"flex",alignItems:"center",gap:5}}>
                        <div style={{width:8,height:8,borderRadius:2,background:col,flexShrink:0}}/>
                        <span style={{fontSize:11,color:C.faint}}>{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
            {npsSummary.all.map((r,i)=>(
              <div key={i} style={{background:C.surface,border:`1px solid ${npsBorder(r.score)}`,borderRadius:10,padding:"12px 16px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:r.comment?8:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <NpsBadge score={r.score} size="lg"/>
                    <span style={{fontSize:12,color:npsColor(r.score),fontWeight:600}}>{npsLabel(r.score)}</span>
                  </div>
                  <div style={{fontSize:11,color:C.vfaint}}>{r.date}</div>
                </div>
                {r.comment&&<div style={{fontSize:13,color:C.muted,lineHeight:1.6,fontStyle:"italic"}}>"{r.comment}"</div>}
              </div>
            ))}
          </div>
        )}

        {/* Executives */}
        {tab==="executives"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {!execs&&!execsLoading&&(
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12,padding:"30px 0"}}>
                <div style={{fontSize:13,color:C.faint}}>Search for finance executives at</div>
                <CustName c={{name:selected.accountName||selected.name,accountName:selected.accountName&&selected.accountName!==selected.name?selected.name:""}} size="lg"/>
                <div style={{fontSize:11,color:C.vfaint,textAlign:"center",maxWidth:400}}>Finds CFOs, VP Finance, Controllers, AP Managers on LinkedIn and drafts escalation emails</div>
                <button onClick={doSearchExecs} style={{background:`linear-gradient(135deg,${C.brand},${C.brandDark})`,border:"none",borderRadius:8,padding:"8px 20px",fontSize:13,fontWeight:600,color:"#fff",cursor:"pointer",marginTop:4}}>Search for executives</button>
              </div>
            )}
            {execsLoading&&<div style={{display:"flex",alignItems:"center",gap:10,padding:"30px 0",justifyContent:"center",fontSize:13,color:C.faint}}><Spinner/>Searching LinkedIn & web…</div>}
            {execsErr&&<div style={{fontSize:13,color:C.red}}>⚠ {execsErr}</div>}
            {execs&&!execsLoading&&(
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {!execs.found||!execs.executives?.length
                  ?<div style={{fontSize:13,color:C.vfaint,textAlign:"center",padding:"20px 0"}}>No finance executives found.</div>
                  :execs.executives.map((exec,i)=>(
                    <div key={i} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
                      <div style={{padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
                        <div style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${C.brand},${C.brandDark})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:700,color:"#fff",flexShrink:0}}>{(exec.name||"?")[0]}</div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:600,color:C.text}}>{exec.name}</div>
                          <div style={{fontSize:11,color:C.faint}}>{exec.title}</div>
                          {exec.email_guess&&<div style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{exec.email_guess}</div>}
                        </div>
                        <div style={{display:"flex",gap:6,flexShrink:0}}>
                          {exec.linkedin_url&&<a href={exec.linkedin_url} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"4px 10px",fontSize:11,color:C.blue,cursor:"pointer",textDecoration:"none"}}>LinkedIn</a>}
                          {!execEmails[i]&&!execEmailLoading[i]&&<button onClick={()=>doGenExecEmail(exec,i)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"4px 10px",fontSize:11,color:C.brand,cursor:"pointer"}}>Draft email</button>}
                          {execEmailLoading[i]&&<span style={{fontSize:11,color:C.faint,display:"flex",alignItems:"center",gap:4}}><Spinner size={12}/>Drafting…</span>}
                        </div>
                      </div>
                      {execEmails[i]&&(
                        <div style={{borderTop:`1px solid ${C.border}`,padding:"10px 16px",background:C.surfaceDim}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                            <div style={{fontSize:11,fontWeight:600,color:C.brand}}>{execEmails[i].subject}</div>
                            <CopyBtn text={`To: ${exec.email_guess||""}\nSubject: ${execEmails[i].subject}\n\n${execEmails[i].body}`}/>
                          </div>
                          <div style={{fontSize:12,color:C.muted,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{execEmails[i].body}</div>
                        </div>
                      )}
                    </div>
                  ))}
                <button onClick={doSearchExecs} style={{alignSelf:"flex-start",background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"4px 10px",fontSize:11,color:C.faint,cursor:"pointer"}}>↻ Search again</button>
              </div>
            )}
          </div>
        )}

        {/* News */}
        {tab==="news"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {!news&&!newsLoading&&(
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12,padding:"30px 0"}}>
                <div style={{fontSize:13,color:C.faint}}>Search the web for news about</div>
                <CustName c={{name:selected.accountName||selected.name,accountName:selected.accountName&&selected.accountName!==selected.name?selected.name:""}} size="lg"/>
                <button onClick={doSearchNews} style={{background:`linear-gradient(135deg,${C.brand},${C.brandDark})`,border:"none",borderRadius:8,padding:"8px 20px",fontSize:13,fontWeight:600,color:"#fff",cursor:"pointer",marginTop:4}}>🔍 Search for news</button>
              </div>
            )}
            {newsLoading&&<div style={{display:"flex",alignItems:"center",gap:10,padding:"30px 0",justifyContent:"center",fontSize:13,color:C.faint}}><Spinner/>Searching the web…</div>}
            {newsErr&&<div style={{fontSize:13,color:C.red}}>⚠ {newsErr}</div>}
            {news&&!newsLoading&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {news.collectionsImpact&&<div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",fontSize:13,color:C.text,lineHeight:1.7}}><span style={{color:C.brand,fontWeight:600}}>Collections impact: </span>{news.collectionsImpact}</div>}
                {(!news.found||!news.signals?.length)
                  ?<div style={{fontSize:13,color:C.vfaint,textAlign:"center",padding:"20px 0"}}>No significant news found.</div>
                  :news.signals.map((s,i)=>{
                    const sc=s.sentiment==="positive"?C.brand:s.sentiment==="negative"?C.red:C.muted;
                    const rc=s.relevance==="high"?C.red:s.relevance==="medium"?C.yellow:C.faint;
                    return (
                      <div key={i} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6,gap:8}}>
                          <div style={{fontSize:13,fontWeight:600,color:C.text,lineHeight:1.4}}>{s.headline}</div>
                          <div style={{display:"flex",gap:6,flexShrink:0}}>
                            <span style={{fontSize:10,background:sc+"22",border:`1px solid ${sc}44`,color:sc,borderRadius:8,padding:"1px 6px"}}>{s.sentiment}</span>
                            <span style={{fontSize:10,background:rc+"22",border:`1px solid ${rc}44`,color:rc,borderRadius:8,padding:"1px 6px"}}>{s.relevance}</span>
                          </div>
                        </div>
                        <div style={{fontSize:12,color:C.muted,lineHeight:1.6,marginBottom:4}}>{s.summary}</div>
                        {s.date&&<div style={{fontSize:11,color:C.vfaint}}>{s.date}</div>}
                      </div>
                    );
                  })}
                <button onClick={doSearchNews} style={{alignSelf:"flex-start",background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"4px 10px",fontSize:11,color:C.faint,cursor:"pointer"}}>↻ Refresh</button>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

// ── App root ──────────────────────────────────────────────────────────────────
export default function App({ user }) {
  const [customers,  setCustomers]  = useState(null);
  const [usageIndex, setUsageIndex] = useState({});
  const [npsIndex,   setNpsIndex]   = useState({});
  const [tasksIndex, setTasksIndex] = useState(null);
  const [view,       setView]       = useState("landing");
  const [selected,   setSelected]   = useState(null);
  const [disputes,   setDisputes]   = useState({});
  const [custSearch, setCustSearch] = useState("");
  const [custDisputeFilter, setCustDisputeFilter] = useState("");
  const [custOverdueFilter, setCustOverdueFilter] = useState("");
  const [custAMFilter, setCustAMFilter] = useState("");
  const [custSortBy, setCustSortBy] = useState("amount");

  // Fetch dispute classifications from the nightly cron output
  function fetchDisputes() {
    fetch("/api/dispute-classifications").then(r=>r.json()).then(data=>{
      const map={};
      for(const d of (data.results||[])) map[d.org_uuid]=d;
      setDisputes(map);
    }).catch(()=>{});
  }

  function handleImport(newC,newU,newN,newT) {
    if (newC) { setCustomers(newC); setSelected(null); }
    if (newU) setUsageIndex(p=>({...p,...newU}));
    if (newN) setNpsIndex(p=>({...p,...newN}));
    if (newT) setTasksIndex(p=>p?{...newT,map:{...p.map,...newT.map}}:newT);
    setView("customers");
    fetchDisputes();
  }

  const showLanding = !customers||view==="landing";

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:C.bg,fontFamily:"'Inter',system-ui,sans-serif",color:C.text,overflow:"hidden"}}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}*{box-sizing:border-box}textarea,input,button{font-family:inherit}`}</style>

      {customers&&!showLanding&&(
        <div style={{display:"flex",alignItems:"center",borderBottom:`1px solid ${C.border}`,background:C.surfaceDim,flexShrink:0}}>
          <div style={{padding:"0 20px",height:44,display:"flex",alignItems:"center",gap:10,borderRight:`1px solid ${C.border}`}}>
            <span style={{fontSize:18}}>🐼</span>
            <span style={{fontSize:10,fontWeight:600,color:C.brand,letterSpacing:2,textTransform:"uppercase"}}>PandaDoc</span>
            <span style={{color:C.faint,fontWeight:300}}>|</span>
            <span style={{fontSize:14,fontWeight:800,color:C.text}}>AR360</span>
          </div>
          {[["customers","Customers"],["hitlist","⚡ Hit List"],["am","AM Breakdown"]].map(([v,label])=>(
            <button key={v} onClick={()=>{setSelected(null);setView(v);}} style={{background:"none",border:"none",borderBottom:view===v?`2px solid ${C.brand}`:"2px solid transparent",padding:"0 18px",height:44,fontSize:13,color:view===v?C.greenLight:C.faint,cursor:"pointer",fontWeight:view===v?600:400}}>
              {label}
            </button>
          ))}
          <div style={{flex:1}}/>
          <button onClick={()=>setView("landing")} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:6,margin:"0 12px",padding:"4px 10px",fontSize:11,color:C.faint,cursor:"pointer"}}>↑ Import more</button>
          <button onClick={()=>signOut()} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:6,margin:"0 12px 0 0",padding:"4px 10px",fontSize:11,color:C.faint,cursor:"pointer"}}>Sign out</button>
        </div>
      )}

      {customers&&!showLanding&&view!=="detail"&&<StatsBar customers={customers} usageIndex={usageIndex} npsIndex={npsIndex} tasksIndex={tasksIndex}/>}

      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        {showLanding&&<LandingScreen onImport={handleImport}/>}
        {!showLanding&&view==="customers"&&(
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            {/* Search + Filter bar */}
            <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.border}`,background:C.surfaceDim,display:"flex",gap:8,alignItems:"center",flexShrink:0,flexWrap:"wrap"}}>
              <input
                value={custSearch} onChange={e=>setCustSearch(e.target.value)}
                placeholder="Search customers…"
                style={{flex:1,minWidth:160,background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,padding:"6px 10px",fontSize:12,color:C.text,outline:"none"}}
              />
              <select value={custDisputeFilter} onChange={e=>setCustDisputeFilter(e.target.value)}
                style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,padding:"6px 8px",fontSize:12,color:C.text,cursor:"pointer"}}>
                <option value="">All dispute types</option>
                {Object.entries(DISPUTE_META).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
              </select>
              <select value={custOverdueFilter} onChange={e=>setCustOverdueFilter(e.target.value)}
                style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,padding:"6px 8px",fontSize:12,color:C.text,cursor:"pointer"}}>
                <option value="">All overdue</option>
                <option value="30">30+ days</option>
                <option value="60">60+ days</option>
                <option value="90">90+ days</option>
              </select>
              <select value={custAMFilter} onChange={e=>setCustAMFilter(e.target.value)}
                style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,padding:"6px 8px",fontSize:12,color:C.text,cursor:"pointer"}}>
                <option value="">All AMs</option>
                {[...new Set(customers.map(c=>c.accountManager).filter(Boolean))].sort().map(am=>(
                  <option key={am} value={am}>{am.replace("@pandadoc.com","")}</option>
                ))}
              </select>
              <select value={custSortBy} onChange={e=>setCustSortBy(e.target.value)}
                style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,padding:"6px 8px",fontSize:12,color:C.text,cursor:"pointer"}}>
                <option value="amount">Sort: Amount</option>
                <option value="overdue">Sort: Days Overdue</option>
                <option value="name">Sort: Name</option>
                <option value="risk">Sort: Risk</option>
              </select>
              {(custSearch||custDisputeFilter||custOverdueFilter||custAMFilter)&&(
                <button onClick={()=>{setCustSearch("");setCustDisputeFilter("");setCustOverdueFilter("");setCustAMFilter("");}}
                  style={{background:"none",border:`1px solid ${C.border}`,borderRadius:7,padding:"6px 10px",fontSize:12,color:C.faint,cursor:"pointer",whiteSpace:"nowrap"}}>
                  Clear
                </button>
              )}
            </div>
            <div style={{flex:1,overflowY:"auto"}}>
            {(()=>{
              let list=[...customers];
              if(custSearch){const q=custSearch.toLowerCase();list=list.filter(c=>(c.name||"").toLowerCase().includes(q)||(c.accountName||"").toLowerCase().includes(q)||(c.accountManager||"").toLowerCase().includes(q));}
              if(custDisputeFilter) list=list.filter(c=>disputes[c.organizationUuid]?.dispute_category===custDisputeFilter);
              if(custAMFilter) list=list.filter(c=>c.accountManager===custAMFilter);
              if(custOverdueFilter) list=list.filter(c=>c.maxDaysOverdue>=parseInt(custOverdueFilter));
              if(custSortBy==="overdue") list.sort((a,b)=>b.maxDaysOverdue-a.maxDaysOverdue);
              else if(custSortBy==="name") list.sort((a,b)=>(a.name||"").localeCompare(b.name||""));
              else if(custSortBy==="risk") list.sort((a,b)=>computeRiskScore(b,usageIndex,npsIndex,disputes).total-computeRiskScore(a,usageIndex,npsIndex,disputes).total);
              else list.sort((a,b)=>b.totalOutstanding-a.totalOutstanding);
              if(!list.length) return <div style={{fontSize:13,color:C.vfaint,textAlign:"center",padding:"40px 0"}}>No customers match your filters.</div>;
              return list.map((c,i)=>{
              const hasUsage=!!usageIndex[c.organizationUuid];
              const nps=getNpsSummary(c,npsIndex);
              const taskCount=getTasks(c,tasksIndex).length;
              const d=disputes[c.organizationUuid];
              return (
                <div key={i} onClick={()=>{setSelected(c);setView("detail");}}
                  style={{padding:"12px 20px",cursor:"pointer",borderBottom:`1px solid ${C.borderDim}`,display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}
                  onMouseOver={e=>e.currentTarget.style.background="#161b28"}
                  onMouseOut={e=>e.currentTarget.style.background="transparent"}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{marginBottom:4,display:"flex",alignItems:"center",gap:8}}><CustName c={c}/><DisputeBadge d={d}/></div>
                    <div style={{fontSize:11,color:C.faint,display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                      <span>{c.invoices.length} inv</span>
                      {c.maxDaysOverdue>0&&<span style={{color:c.maxDaysOverdue>60?C.red:C.yellow}}>· {c.maxDaysOverdue}d overdue</span>}
                      {hasUsage&&<span style={{color:C.brand}}>· usage ✓</span>}
                      {taskCount>0&&<span style={{color:C.brand}}>· {taskCount} tasks</span>}
                      {c.accountManager&&<span>· {c.accountManager.replace("@pandadoc.com","")}</span>}
                    </div>
                  </div>
                  <div style={{flexShrink:0,textAlign:"center",minWidth:52}}>
                    {nps?(
                      <div style={{background:npsBg(nps.avg),border:`1px solid ${npsBorder(nps.avg)}`,borderRadius:8,padding:"4px 8px"}}>
                        <div style={{fontSize:9,color:C.faint,textTransform:"uppercase",letterSpacing:0.5,marginBottom:1}}>NPS</div>
                        <div style={{fontSize:16,fontWeight:800,color:npsColor(nps.avg),lineHeight:1}}>{nps.avg}</div>
                        <div style={{fontSize:8,color:npsColor(nps.avg),marginTop:1}}>{npsLabel(nps.avg)}</div>
                      </div>
                    ):(
                      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"4px 8px",opacity:0.4}}>
                        <div style={{fontSize:9,color:C.faint,textTransform:"uppercase",letterSpacing:0.5,marginBottom:1}}>NPS</div>
                        <div style={{fontSize:14,color:C.vfaint,lineHeight:1}}>—</div>
                      </div>
                    )}
                  </div>
                  <div style={{fontSize:14,fontWeight:700,color:c.maxDaysOverdue>60?C.red:C.text,flexShrink:0,minWidth:80,textAlign:"right"}}>{fmt(c.totalOutstanding,c.currency)}</div>
                </div>
              );
              });
            })()}
            </div>
          </div>
        )}
        {!showLanding&&view==="hitlist"&&<HitList customers={customers} usageIndex={usageIndex} npsIndex={npsIndex} tasksIndex={tasksIndex} onSelect={c=>{setSelected(c);setView("detail");}} disputes={disputes} user={user}/>}
        {!showLanding&&view==="am"&&<AMBreakdown customers={customers}/>}
        {!showLanding&&view==="detail"&&selected&&<CustomerDetail key={selected.name} selected={selected} usageIndex={usageIndex} npsIndex={npsIndex} tasksIndex={tasksIndex} onBack={()=>setView("customers")} dispute={disputes[selected.organizationUuid]} user={user}/>}
      </div>
    </div>
  );
}
import { useState, useRef, useEffect, useMemo } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts';
import {
  initNexus, getMemory, nexusChat, nexusResearch, nexusPrices, nexusMarketBriefing,
  nexusInvestmentProposal, classifyQuery, PROVIDER_META, PROFILES, EMPTY_PROFILE,
  // Herramientas exclusivas
  stressTest, detectDrift, rebalancePlan, taxLossOpportunities, portfolioRiskScore,
  formatStressResults, formatDrift, formatTaxLoss,
  // Motor autónomo
  loadAlerts, markAlertRead, clearAlerts, unreadCount, addAlert,
  startMonitor, stopMonitor,
  loadAutonomousConfig, saveAutonomousConfig, evaluateAurumPerformance,
  saveRecommendation,
  // Motor de decisión autónoma
  loadAutoConfig, saveAutoConfig, loadActionLog,
  startDecisionScheduler, stopDecisionScheduler,
  // Auto-mejora
  loadLessons, clearLessons,
  // Intérprete de comandos + control de PC/navegador
  detectActionIntent, executeCommand, commandResultToMessage,
  runBrowserTask, runLocalAgentTask, getAgentStatus,
  // Token tracking
  loadTokenBudget, resetTokenBudget, estimateCost,
} from './nexus/index';
import type { TokenBudget } from './nexus/index';
import type { ComputerTaskResult } from './nexus/index';
import type {
  AgentKey, ChatMessage, DisplayMessage, InvestmentProposal, Position, RouteResult, UserProfile,
  AurumAlert, AutonomousConfig, AutoInvestConfig, ActionLogEntry, Decision, Lesson,
} from './nexus/index';
import { MODELO_DE_AJUSTES, callAnthropic, callProvider } from './nexus/providers';
import * as store from './store/state';
import * as compartido from './store/captura-compartida';
import * as atras from './store/atras';
import { calcularAvisos } from './nexus/avisos';
import { CLAVE_PLANES, aportacionMensual, bloquePlanes, normalizarPlan, type PlanInversion } from './nexus/planes';
import { REVISION_SYSTEM } from './nexus/prompts';
import { C, PIE_PAL } from './theme';
import { useSession } from './store/session-context';
import { createInvite } from './store/session';
import { API_BASE, ApiError, apiFetch, apiFetchRaw, isNative } from './store/api';
import { MODELO_AUTOMATICO, deleteProviderKey, fetchModelos, fetchProviderKeys, saveProviderKey,
         type CatalogoModelos, type ProviderKeyStatus } from './store/keys';

/* ══════════════════════════════════════════════════════════════
   BOOTSTRAP
══════════════════════════════════════════════════════════════ */
const bootstrap = () => {
  if (document.getElementById('aurum-fonts')) return;
  const l = document.createElement('link');
  l.id = 'aurum-fonts'; l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,400&family=DM+Mono:wght@300;400;500&family=Sora:wght@300;400;500;600&display=swap';
  document.head.appendChild(l);
  const s = document.createElement('style'); s.id = 'aurum-style';
  s.textContent = `
    @keyframes pulse-dot  { 0%,80%,100%{transform:scale(.5);opacity:.3} 40%{transform:scale(1);opacity:1} }
    @keyframes slide-up   { from{opacity:0;transform:translateY(7px)} to{opacity:1;transform:translateY(0)} }
    @keyframes orb-float  { 0%,100%{opacity:.45;transform:scale(1)} 50%{opacity:.7;transform:scale(1.06)} }
    @keyframes step-slide { from{opacity:0;transform:translateX(-10px)} to{opacity:1;transform:translateX(0)} }
    @keyframes spin        { to{transform:rotate(360deg)} }
    .msg-in    { animation: slide-up  .26s ease both }
    .step-in   { animation: step-slide .3s ease both }
    .nav-icon:hover  { background:rgba(201,168,76,.12)!important; color:#c9a84c!important }
    .card-h:hover    { border-color:rgba(201,168,76,.28)!important }
    .pos-row:hover   { background:rgba(255,255,255,.022)!important }
    .agent-tab:hover { background:rgba(201,168,76,.07)!important }
    .send-btn:hover:not(:disabled) { background:#e8c96a!important; transform:scale(1.07) }
    .send-btn:disabled { opacity:.3!important; cursor:not-allowed!important }
    ::-webkit-scrollbar { width:3px; height:3px }
    ::-webkit-scrollbar-thumb { background:#1c1c2e; border-radius:3px }
    textarea::placeholder { color:#252540 }
    textarea { caret-color:#c9a84c }
    input::placeholder { color:#252540 }
    input[type=range] { accent-color:#c9a84c; cursor:pointer }
    * { box-sizing:border-box }
    html,body { height:100%; overflow:hidden; }
    .bnav-btn:active { transform:scale(.93)!important }
    .bnav-btn.active .bnav-icon { transform:translateY(-2px) }
    @media (max-width:600px) { ::-webkit-scrollbar { display:none } }
  `;
  document.head.appendChild(s);
};

/* ══════════════════════════════════════════════════════════════
   DESIGN TOKENS
══════════════════════════════════════════════════════════════ */
// Paleta compartida con la pantalla de acceso (src/theme.ts).

/* ══════════════════════════════════════════════════════════════
   VERSION
══════════════════════════════════════════════════════════════ */
// Del package.json, para que no haya dos versiones que puedan discrepar:
// esta llevaba cuatro publicaciones diciendo 1.2.1.
const APP_VERSION = __APP_VERSION__;
const APP_BUILD   = '2026.06.24';

/* ══════════════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════════════ */
const NAV = [
  { id:'chat',      icon:'💬', label:'Chat'      },
  { id:'portfolio', icon:'📁', label:'Cartera'   },
  { id:'invest',    icon:'💰', label:'Invertir'  },
  { id:'research',  icon:'🔬', label:'Research'  },
  { id:'control',   icon:'🖥️', label:'Control'   },
  { id:'simulator', icon:'🧮', label:'Simulador' },
  { id:'settings',  icon:'⚙️', label:'Ajustes'   },
];

const AGENTS: Record<AgentKey, { name:string; icon:string; color:string; desc:string }> = {
  aurum:  { name:'AURUM',  icon:'◈',  color:C.gold,    desc:'Asesor integral · Claude'    },
  macro:  { name:'MACRO',  icon:'🌐', color:C.blue,    desc:'Macro · GPT-4o Search'       },
  riesgo: { name:'RIESGO', icon:'⚖️', color:'#e8734a', desc:'Riesgos · DeepSeek R1'       },
  fiscal: { name:'FISCAL', icon:'🧾', color:C.green,   desc:'Fiscal España · Claude'      },
};

const RESEARCH_STEPS: { label:string; task:string; q:(a:string)=>string }[] = [
  { label:'Noticias y catalizadores',    task:'news',       q:a=>`${a} noticias recientes catalizadores novedades importantes 2025` },
  { label:'Resultados y finanzas',       task:'financials', q:a=>`${a} resultados financieros revenue beneficios earnings guidance 2024 2025` },
  { label:'Análisis de analistas',       task:'analysts',   q:a=>`${a} precio objetivo analistas consenso recomendación buy hold sell wall street` },
  { label:'Contexto macro y sector',     task:'macro',      q:a=>`sector ${a} tendencias perspectivas competidores cuota de mercado 2025` },
  { label:'Riesgos y factores bajistas', task:'risks',      q:a=>`${a} riesgos amenazas problemas regulatorios competencia debilidades bear case` },
];

/* ══════════════════════════════════════════════════════════════
   STORAGE
══════════════════════════════════════════════════════════════ */
// El estado del usuario vive en D1 (ver src/store/state.ts). Estas dos
// funciones se mantienen async porque así las llama todo App.tsx, pero la
// lectura es inmediata: el store tiene el estado en memoria desde el login.
const sGet = async <T = any,>(k:string): Promise<T|null> => store.get<T|null>(k, null);
const sSet = async (k:string, v:unknown): Promise<void> => { store.set(k, v); };

/* ── Backend helpers ──────────────────────────────────────────── */
interface BackendConfig { url: string; apiKey: string; }

async function backendCall(cfg: BackendConfig, path: string, method='GET', body?: unknown) {
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'Content-Type':'application/json', 'X-AURUM-KEY': cfg.apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status}: ${err}`);
  }
  return res.json();
}

async function getBackendConfig(): Promise<BackendConfig|null> {
  const cfg = await sGet('aurum-backend-config');
  if (!cfg?.url || !cfg?.apiKey) return null;
  return cfg;
}

/* ══════════════════════════════════════════════════════════════
   SHARED COMPONENTS
══════════════════════════════════════════════════════════════ */
function Spinner() {
  return <div style={{ width:14, height:14, borderRadius:'50%', border:`2px solid ${C.gold}40`, borderTopColor:C.gold, animation:'spin .8s linear infinite' }} />;
}
function Dots({ color }:{ color?:string }) {
  return <div style={{ display:'flex', gap:5, alignItems:'center' }}>
    {[0,1,2].map(j=><div key={j} style={{ width:7, height:7, borderRadius:'50%', background:color||C.gold, animation:`pulse-dot 1.4s ease ${j*.2}s infinite` }}/>)}
  </div>;
}

function ProviderBadge({ provider, model }:{ provider?:string; model?:string }) {
  if (!provider) return null;
  const meta = PROVIDER_META[provider as keyof typeof PROVIDER_META];
  if (!meta) return null;
  const short = model?.includes('reasoner') ? 'DeepSeek R1' : model?.includes('search') ? 'GPT-4o Search' : meta.short;
  return (
    <span style={{ fontSize:'.58em', padding:'2px 6px', borderRadius:4, background:`${meta.color}18`, border:`1px solid ${meta.color}40`, color:meta.color, fontFamily:"'DM Mono',monospace", letterSpacing:'.3px' }}>
      {short}
    </span>
  );
}

function Md({ text }:{ text:string }) {
  const lines = (text||'').split('\n');
  let k = 0;
  const inline = (s:string) => {
    const out:React.ReactNode[] = []; let rem=s, j=0;
    while (rem.length) {
      const bm=rem.match(/\*\*(.+?)\*\*/), cm=rem.match(/`([^`]+)`/);
      const first=[bm,cm].filter(Boolean).sort((a,b)=>a!.index!-b!.index!)[0];
      if (!first) { out.push(<span key={j++}>{rem}</span>); break; }
      if (first.index!>0) out.push(<span key={j++}>{rem.slice(0,first.index)}</span>);
      if (first===bm) out.push(<strong key={j++} style={{ color:C.goldL, fontWeight:600 }}>{bm![1]}</strong>);
      else out.push(<code key={j++} style={{ background:'#11112a', border:'1px solid #2a2a44', borderRadius:4, padding:'1px 5px', fontSize:'.82em', fontFamily:"'DM Mono',monospace", color:'#8ad8a8' }}>{cm![1]}</code>);
      rem=rem.slice(first.index!+first[0].length);
    }
    return out;
  };
  return (
    <div>
      {lines.map(l => {
        const key=k++;
        if (!l.trim()) return <div key={key} style={{ height:5 }}/>;
        if (l.startsWith('## '))  return <div key={key} style={{ fontSize:'1.04em', fontWeight:600, color:C.goldL, margin:'14px 0 4px', fontFamily:"'Cormorant Garamond',serif", letterSpacing:'.5px' }}>{inline(l.slice(3))}</div>;
        if (l.startsWith('### ')) return <div key={key} style={{ fontSize:'.92em', fontWeight:600, color:C.gold, margin:'9px 0 3px' }}>{inline(l.slice(4))}</div>;
        if (l.match(/^[-•]\s/))   return <div key={key} style={{ display:'flex', gap:8, marginBottom:3, paddingLeft:4 }}><span style={{ color:C.gold, flexShrink:0, marginTop:2 }}>◆</span><span>{inline(l.slice(2))}</span></div>;
        if (l.match(/^\d+\.\s/))  { const [n,...r]=l.split(/\.\s/); return <div key={key} style={{ display:'flex', gap:8, marginBottom:3, paddingLeft:4 }}><span style={{ color:C.gold, flexShrink:0, minWidth:14 }}>{n}.</span><span>{inline(r.join('. '))}</span></div>; }
        return <p key={key} style={{ margin:'2px 0', lineHeight:1.75 }}>{inline(l)}</p>;
      })}
    </div>
  );
}

const Card = ({ children, style={} }:{ children:React.ReactNode; style?:React.CSSProperties }) => (
  <div className="card-h" style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, overflow:'hidden', transition:'border-color .2s', ...style }}>{children}</div>
);

const inputBase:React.CSSProperties = { background:C.surf2, border:`1px solid ${C.border2}`, borderRadius:9, padding:'8px 11px', color:C.text, fontSize:'.82em', fontFamily:"'Sora',sans-serif", outline:'none', width:'100%', transition:'border-color .2s' };

/* ── ISIN map para vender directamente desde la UI ───────────────────────── */
const ISIN_MAP: Record<string, string> = {
  // ETFs globales
  VWCE: 'IE00B3RBWM25', XEON: 'LU0290358497', SPPW: 'IE00B3YCGJ38',
  SGLN: 'IE00B579F325', EUNL: 'IE00B4L5Y983', VUSA: 'IE00B3XXRP09',
  BTCE: 'DE000A27Z304', WGLD: 'DE000A2T6WD2', IEMA: 'IE00BKM4GZ66',
  ZPRV: 'IE00BMT04N44', IS3N: 'IE00B14X4T88', QDVE: 'IE00BYML9W36',
  AGGU: 'IE00B3F81409', XDWD: 'IE00B3F81R35', IWDA: 'IE00B4L5Y983',
  EXXT: 'DE0002635307', VHYL: 'IE00B8GKDB10', IBTS: 'IE00B14X4T88',
  // Acciones US
  AAPL: 'US0378331005', MSFT: 'US5949181045', NVDA: 'US67066G1040',
  AMZN: 'US0231351067', GOOGL: 'US02079K3059', TSLA: 'US88160R1014',
  META: 'US30303M1027', NFLX: 'US64110L1061', ORCL: 'US68389X1054',
  // Acciones EU
  ASML: 'NL0010273215', SAP: 'DE0007164600', LVMH: 'FR0000121014',
  SAN: 'ES0113900J37', IBE: 'ES0144580Y14', ITX: 'ES0148396007',
};

/* ══════════════════════════════════════════════════════════════
   MARKET TICKER (índices en tiempo real vía Cloudflare Worker)
══════════════════════════════════════════════════════════════ */
interface MarketQuote { key:string; name:string; price:number|null; changePct:number|null; currency?:string }

function MarketTicker() {
  const [quotes,  setQuotes]  = useState<MarketQuote[]>([]);
  const [lastTs,  setLastTs]  = useState(0);

  const load = async () => {
    // Intento 1: Cloudflare Worker en producción (/api/market)
    try {
      const res = await fetch('/api/market');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.data)) { setQuotes(data.data); setLastTs(data.ts || Date.now()); return; }
      }
    } catch { /* sin CF Worker en dev — silencioso */ }

    // Intento 2: backend local (desarrollo / IP privada)
    try {
      const cfg = await getBackendConfig();
      if (cfg?.url) {
        const res2 = await fetch(`${cfg.url.replace(/\/$/, '')}/market`);
        if (res2.ok) {
          const data2 = await res2.json();
          if (Array.isArray(data2?.data)) { setQuotes(data2.data); setLastTs(data2.ts || Date.now()); }
        }
      }
    } catch { /* silencioso */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!quotes.length) return null;

  return (
    <div style={{
      background:'#07070e', borderBottom:`1px solid ${C.border}22`,
      display:'flex', alignItems:'center', height:24, padding:'0 14px',
      gap:0, overflowX:'auto', flexShrink:0, zIndex:9, position:'relative',
      scrollbarWidth:'none',
    }}>
      {quotes.map((q, i) => {
        if (q.price === null) return null;
        const up = (q.changePct ?? 0) >= 0;
        const color = up ? C.green : C.red;
        const isFx = q.currency === 'FX';
        const fmtPrice = isFx
          ? q.price.toFixed(4)
          : q.price >= 10000
            ? q.price.toLocaleString('es-ES', { maximumFractionDigits:0 })
            : q.price.toLocaleString('es-ES', { maximumFractionDigits:2 });
        return (
          <div key={q.key} style={{ display:'flex', alignItems:'center', gap:4, padding:'0 10px', borderRight: i < quotes.length-1 ? `1px solid ${C.border}33` : 'none', flexShrink:0 }}>
            <span style={{ fontSize:'.58em', color:C.faint, fontFamily:"'DM Mono',monospace", letterSpacing:'.3px' }}>{q.name}</span>
            <span style={{ fontSize:'.63em', color:C.text, fontFamily:"'DM Mono',monospace", fontWeight:500 }}>{fmtPrice}</span>
            {q.changePct !== null && (
              <span style={{ fontSize:'.56em', color, fontFamily:"'DM Mono',monospace" }}>
                {up ? '▲' : '▼'}{Math.abs(q.changePct).toFixed(2)}%
              </span>
            )}
          </div>
        );
      })}
      {lastTs > 0 && (
        <div style={{ marginLeft:'auto', flexShrink:0, paddingLeft:8 }}>
          <span style={{ fontSize:'.52em', color:C.faint, fontFamily:"'DM Mono',monospace" }}>
            {new Date(lastTs).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}
          </span>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   ALERT CENTER
══════════════════════════════════════════════════════════════ */
function AlertCenter({ onClose, onNavigate }:{ onClose:()=>void; onNavigate:(tab:string)=>void }) {
  const [alerts, setAlerts] = useState<AurumAlert[]>([]);
  useEffect(() => { setAlerts([...loadAlerts()].reverse()); }, []);

  const sev = (a: AurumAlert) =>
    a.severity === 'critical' ? C.red : a.severity === 'warning' ? '#e8734a' : C.blue;

  const read = (id: string) => { markAlertRead(id); setAlerts(prev => prev.map(a => a.id===id?{...a,read:true}:a)); };
  const clear = () => { clearAlerts(); setAlerts([]); };

  return (
    <div style={{ position:'fixed', top:0, right:0, width:340, height:'100vh', background:C.surf, borderLeft:`1px solid ${C.border}`, zIndex:200, display:'flex', flexDirection:'column', boxShadow:'-8px 0 32px #00000088' }}>
      <div style={{ padding:'14px 16px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={{ fontSize:'.78em', fontWeight:600, color:C.goldL }}>Centro de Alertas</div>
          <div style={{ fontSize:'.62em', color:C.muted, marginTop:2 }}>{alerts.filter(a=>!a.read).length} sin leer · {alerts.length} total</div>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {alerts.length > 0 && <button onClick={clear} style={{ background:'transparent', border:`1px solid ${C.border2}`, color:C.muted, cursor:'pointer', fontSize:'.65em', borderRadius:6, padding:'3px 8px', fontFamily:"'Sora',sans-serif" }}>Limpiar</button>}
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:C.muted, cursor:'pointer', fontSize:'1.1em' }}>✕</button>
        </div>
      </div>
      <div style={{ flex:1, overflow:'auto', padding:'10px 14px', display:'flex', flexDirection:'column', gap:8 }}>
        {alerts.length === 0 && (
          <div style={{ color:C.faint, fontSize:'.78em', lineHeight:1.6, paddingTop:12 }}>No hay alertas. AURUM monitoriza tu cartera automáticamente cada hora.</div>
        )}
        {alerts.map(a => (
          <div key={a.id} onClick={() => read(a.id)} style={{ padding:'10px 12px', background: a.read?'#0a0a14':`${sev(a)}08`, border:`1px solid ${a.read?C.border:sev(a)+'44'}`, borderRadius:10, cursor:'pointer', transition:'all .2s', opacity: a.read ? 0.65 : 1 }}>
            <div style={{ display:'flex', alignItems:'flex-start', gap:8, marginBottom:4 }}>
              <div style={{ width:7, height:7, borderRadius:'50%', background: a.read ? C.faint : sev(a), flexShrink:0, marginTop:3, boxShadow: a.read ? 'none' : `0 0 6px ${sev(a)}` }} />
              <div style={{ fontSize:'.78em', fontWeight:600, color: a.read ? C.muted : C.text, lineHeight:1.3 }}>{a.title}</div>
            </div>
            <div style={{ fontSize:'.7em', color:C.muted, lineHeight:1.5, paddingLeft:15 }}>{a.body}</div>
            {a.actionable && a.actionTab && !a.read && (
              <button onClick={e => { e.stopPropagation(); read(a.id); onClose(); onNavigate(a.actionTab!); }}
                style={{ marginTop:7, marginLeft:15, background:`${sev(a)}18`, border:`1px solid ${sev(a)}44`, borderRadius:6, padding:'4px 10px', color:sev(a), cursor:'pointer', fontSize:'.65em', fontFamily:"'Sora',sans-serif" }}>
                {a.action} →
              </button>
            )}
            <div style={{ fontSize:'.6em', color:C.faint, marginTop:5, paddingLeft:15 }}>
              {new Date(a.createdAt).toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   MEMORY PANEL  (shown in chat sidebar)
══════════════════════════════════════════════════════════════ */
function MemoryPanel({ onClose }:{ onClose:()=>void }) {
  const mem = getMemory();
  return (
    <div style={{ position:'fixed', top:0, right:0, width:320, height:'100vh', background:C.surf, borderLeft:`1px solid ${C.border}`, zIndex:100, display:'flex', flexDirection:'column', boxShadow:'-8px 0 32px #00000066' }}>
      <div style={{ padding:'16px 18px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div>
          <div style={{ fontSize:'.78em', fontWeight:600, color:C.goldL }}>Memoria Nexus</div>
          <div style={{ fontSize:'.62em', color:C.muted, marginTop:2 }}>{mem.facts.length} hechos · {mem.interactions} interacciones</div>
        </div>
        <button onClick={onClose} style={{ background:'transparent', border:'none', color:C.muted, cursor:'pointer', fontSize:'1.1em' }}>✕</button>
      </div>
      <div style={{ flex:1, overflow:'auto', padding:'14px 18px' }}>
        {mem.facts.length === 0
          ? <div style={{ color:C.faint, fontSize:'.78em', lineHeight:1.6 }}>Aún no hay hechos almacenados. La memoria se construye automáticamente conforme conversa el usuario (cada 5 interacciones).</div>
          : mem.facts.map((f,i) => (
            <div key={i} style={{ display:'flex', gap:8, marginBottom:9, padding:'8px 10px', background:'#0a0a1a', border:`1px solid ${C.border}`, borderRadius:8, fontSize:'.75em', color:C.text, lineHeight:1.5 }}>
              <span style={{ color:C.gold, flexShrink:0 }}>◆</span>{f}
            </div>
          ))}
      </div>
      {mem.lastUpdated > 0 && (
        <div style={{ padding:'10px 18px', borderTop:`1px solid ${C.border}`, fontSize:'.62em', color:C.faint }}>
          Actualizado: {new Date(mem.lastUpdated).toLocaleString('es-ES')}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   CHAT TAB
══════════════════════════════════════════════════════════════ */
const HIST_KEY_AUTO = 'aurum-hist-auto';
const MAX_HIST = 80;

const WELCOME_AUTO: DisplayMessage = {
  role: 'assistant',
  content: `Bienvenido a **AURUM Nexus** — tu asesor financiero con IA.\n\nDetecto automáticamente qué experto usar según tu pregunta:\n- 🌐 **MACRO** · mercados, economía y noticias en tiempo real\n- ⚖️ **RIESGO** · VaR, Sharpe, volatilidad y análisis cuantitativo\n- 🧾 **FISCAL** · IRPF, plusvalías y optimización fiscal en España\n- ◈ **AURUM** · estrategia, cartera y asesoramiento general\n\n¿En qué te puedo ayudar?`,
  provider: 'anthropic',
  agent: 'aurum',
};

function ChatTab({ profile, portfolio, userProfile }:{ profile:string; portfolio:Position[]; userProfile:UserProfile }) {
  const [history, setHistory]     = useState<DisplayMessage[]>([]);
  const [histLoaded, setHistLoaded] = useState(false);
  const [input, setInput]         = useState('');
  const [loading, setLoading]     = useState(false);
  const [searching, setSearching] = useState(false);
  const [activeRoute, setActiveRoute] = useState<RouteResult|null>(null);
  const [pendingAgent, setPendingAgent] = useState<AgentKey>('aurum');
  const [file, setFile]           = useState<{ name:string; type:string; b64:string }|null>(null);
  const [showMem, setShowMem]     = useState(false);
  const endRef  = useRef<HTMLDivElement>(null);
  const taRef   = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    sGet(HIST_KEY_AUTO).then(saved => {
      setHistory(saved && saved.length > 0 ? saved : [WELCOME_AUTO]);
      setHistLoaded(true);
    });
  }, []);

  // Lee el prefill de sessionStorage (puesto por RebalanceCard al navegar al chat)
  useEffect(() => {
    const prefill = sessionStorage.getItem('aurum-chat-prefill');
    if (prefill) {
      sessionStorage.removeItem('aurum-chat-prefill');
      setInput(prefill);
      requestAnimationFrame(() => {
        if (taRef.current) {
          taRef.current.style.height = 'auto';
          taRef.current.style.height = Math.min(taRef.current.scrollHeight, 120) + 'px';
          taRef.current.focus();
        }
      });
    }
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior:'smooth' }); }, [history, loading]);

  const handleFile = (e:React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setFile({ name:f.name, type:f.type, b64:(reader.result as string).split(',')[1] });
    reader.readAsDataURL(f);
    e.target.value = '';
  };

  const send = async (override?:string) => {
    const raw = (override||input).trim();
    if (!raw && !file) return;
    if (loading) return;
    const txt = raw || (file ? 'Analiza este documento' : '');
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';

    // ── Command interception: detect action intent and execute via backend ──
    if (!file) {
      const intent = detectActionIntent(txt);
      if (intent.type !== 'none') {
        const cfg = await getBackendConfig();
        if (cfg) {
          const userDisplayMsg: DisplayMessage = { role:'user', content:txt };
          const withUser = [...history, userDisplayMsg];
          setHistory(withUser);
          setLoading(true);
          if (intent.type === 'computer') setSearching(true);  // visual feedback for long computer tasks
          try {
            const result = await executeCommand(intent, portfolio, profile, userProfile, cfg);
            const reply = commandResultToMessage(intent, result);
            // For computer tasks, append screenshot info if available
            const data = result.data as any;
            const extra = (intent.type === 'computer' && data?.steps)
              ? ` *(${data.steps} pasos)*` : '';
            const assistantMsg: DisplayMessage = {
              role:'assistant',
              content: (reply || (result.success ? '✅ Completado.' : `❌ ${result.message}`)) + extra,
              provider:'anthropic', agent:'aurum',
            };
            const finalHist = [...withUser, assistantMsg];
            setHistory(finalHist);
            sSet(HIST_KEY_AUTO, finalHist.slice(-MAX_HIST));
          } catch(e:any) {
            const errMsg: DisplayMessage = { role:'assistant', content:`⚠️ Error ejecutando comando: ${e?.message||String(e)}`, agent:'aurum' };
            setHistory([...withUser, errMsg]);
          } finally { setLoading(false); setSearching(false); }
          return;  // no llames al chat de IA
        }
        // Si no hay backend configurado, continúa normalmente con el chat
      }
    }

    // Auto-detect which expert to use
    const agentKey = classifyQuery(txt);
    setPendingAgent(agentKey);

    const displayMsg = file ? `📎 *${file.name}*\n${txt}` : txt;
    let apiContent: string | unknown[] = txt;
    if (file?.type.startsWith('image/')) {
      apiContent = [
        { type:'image', source:{ type:'base64', media_type:file.type, data:file.b64 } },
        { type:'text',  text:txt },
      ];
    } else if (file?.type === 'application/pdf') {
      const isAnthropicAgent = agentKey === 'aurum' || agentKey === 'fiscal';
      if (isAnthropicAgent) {
        apiContent = [
          { type:'document', source:{ type:'base64', media_type:'application/pdf', data:file.b64 } },
          { type:'text', text:txt },
        ];
      } else {
        apiContent = `[PDF adjunto: ${file.name} — solo AURUM y FISCAL pueden leer PDFs]\n${txt}`;
      }
    }
    setFile(null);

    const userDisplayMsg: DisplayMessage = { role:'user', content:displayMsg };
    const withUser = [...history, userDisplayMsg];
    setHistory(withUser);
    setLoading(true); setSearching(false); setActiveRoute(null);

    const apiHist: ChatMessage[] = withUser
      .filter((m,i) => !(i===0 && m.role==='assistant'))
      .slice(-20)
      .map(m => ({ role: m.role as 'user'|'assistant', content: m.content }));
    if (apiHist.length > 0) apiHist[apiHist.length-1] = { role:'user', content: apiContent };

    let routeResult: RouteResult|null = null;
    try {
      const reply = await nexusChat(
        agentKey, apiHist, profile, portfolio,
        () => setSearching(true),
        r  => { setActiveRoute(r); routeResult = r; },
        userProfile,
        // Los planes periodicos tambien: preguntes lo que preguntes, que compres
        // 300 al mes cambia la respuesta.
        await sGet<PlanInversion[]>(CLAVE_PLANES) ?? [],
      );
      const assistantMsg: DisplayMessage = { role:'assistant', content:reply, provider:routeResult?.provider, model:routeResult?.model, agent:agentKey };
      const finalHist = [...withUser, assistantMsg];
      setHistory(finalHist);
      sSet(HIST_KEY_AUTO, finalHist.slice(-MAX_HIST));
    } catch(e:any) {
      const detail = e?.message || String(e);
      const errMsg: DisplayMessage = { role:'assistant', content:`⚠️ **Error**: ${detail}\n\nSi el error persiste, recarga la página (Ctrl+F5).`, agent:agentKey };
      const finalHist = [...withUser, errMsg];
      setHistory(finalHist);
      sSet(HIST_KEY_AUTO, finalHist.slice(-MAX_HIST));
      console.error('[AURUM] nexusChat error:', detail);
    } finally { setLoading(false); setSearching(false); }
  };

  const memCount = getMemory().facts.length;
  const loadingAgent = AGENTS[pendingAgent];

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
      {/* Header bar */}
      <div style={{ display:'flex', alignItems:'center', background:C.surf, borderBottom:`1px solid ${C.border}`, flexShrink:0, padding:'0 14px', height:42 }}>
        <span style={{ fontSize:'.72em', color:C.gold, fontFamily:"'DM Mono',monospace", letterSpacing:'.8px', fontWeight:600 }}>AURUM NEXUS</span>
        <span style={{ fontSize:'.62em', color:C.faint, marginLeft:10 }}>modo automático</span>
        <div style={{ flex:1 }} />
        {searching && (
          <div style={{ display:'flex', alignItems:'center', gap:5, marginRight:8, fontSize:'.65em', color:C.gold }}>
            <Spinner /><span>buscando…</span>
          </div>
        )}
        <button onClick={() => { setHistory([WELCOME_AUTO]); sSet(HIST_KEY_AUTO, [WELCOME_AUTO]); }}
          title="Limpiar conversación"
          style={{ display:'flex', alignItems:'center', padding:'0 8px', background:'transparent', border:'none', cursor:'pointer', fontSize:'.72em', color:C.faint }}
          onMouseEnter={e=>(e.currentTarget.style.color=C.red)} onMouseLeave={e=>(e.currentTarget.style.color=C.faint)}>
          🗑
        </button>
        <button onClick={() => setShowMem(v=>!v)} title="Memoria Nexus"
          style={{ display:'flex', alignItems:'center', gap:5, padding:'0 10px', background:'transparent', border:'none', cursor:'pointer', fontSize:'.65em', color:memCount>0?C.gold:C.faint }}>
          🧠 {memCount > 0 ? <span style={{ color:C.gold }}>{memCount}</span> : <span>0</span>}
        </button>
      </div>

      {/* Messages */}
      <div style={{ flex:1, overflow:'auto', padding:'18px 22px' }}>
        {!histLoaded && (
          <div style={{ display:'flex', justifyContent:'center', alignItems:'center', height:120 }}>
            <Dots color={C.faint} />
          </div>
        )}
        {histLoaded && history.map((m,i) => {
          const isUser = m.role === 'user';
          const msgAgent = AGENTS[m.agent || 'aurum'];
          return (
            <div key={i} className="msg-in" style={{ display:'flex', flexDirection:'column', alignItems:isUser?'flex-end':'flex-start', marginBottom:14 }}>
              {!isUser && (
                <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:5 }}>
                  <div style={{ width:24, height:24, borderRadius:7, background:`linear-gradient(135deg,${msgAgent.color}70,${msgAgent.color})`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:800, color:'#07070e', flexShrink:0 }}>{msgAgent.icon}</div>
                  <span style={{ fontSize:'.62em', color:C.muted, fontFamily:"'DM Mono',monospace", letterSpacing:'.5px' }}>{msgAgent.name}</span>
                  <ProviderBadge provider={m.provider} model={m.model} />
                </div>
              )}
              <div style={{ maxWidth:isUser?'68%':'90%', padding:'12px 16px', borderRadius:isUser?'14px 14px 3px 14px':'3px 14px 14px 14px', background:isUser?'#16163a':C.surf2, border:`1px solid ${isUser?'#28284e':C.border}`, fontSize:'.86em', lineHeight:1.72, color:isUser?'#aaaadd':C.text, wordBreak:'break-word' }}>
                {isUser ? <span style={{ whiteSpace:'pre-wrap' }}>{m.content}</span> : <Md text={m.content} />}
              </div>
            </div>
          );
        })}
        {loading && (
          <div className="msg-in" style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14 }}>
            <div style={{ width:24, height:24, borderRadius:7, background:`linear-gradient(135deg,${loadingAgent.color}70,${loadingAgent.color})`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:10 }}>{loadingAgent.icon}</div>
            <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:'3px 14px 14px 14px', padding:'12px 16px', display:'flex', gap:10, alignItems:'center' }}>
              <Dots color={loadingAgent.color} />
              <span style={{ fontSize:'.68em', color:loadingAgent.color, fontFamily:"'DM Mono',monospace" }}>
                {loadingAgent.name}{activeRoute ? (searching ? ' buscando…' : ' pensando…') : '…'}
              </span>
            </div>
          </div>
        )}
        {/* Quick-action chips — shown only when chat is empty (only welcome message) */}
        {histLoaded && history.length === 1 && history[0].role === 'assistant' && !loading && (
          <div style={{ display:'flex', flexWrap:'wrap', gap:8, padding:'4px 0 12px' }}>
            {([
              { label:'📊 Analizar mi cartera',   msg:'Analiza mi cartera actual y dame recomendaciones personalizadas' },
              { label:'🔍 Briefing de mercados',  msg:'Dame un briefing completo de los mercados hoy' },
              { label:'💡 ¿Qué debería comprar?', msg:'¿Qué activos me recomiendas comprar ahora mismo según mi perfil?' },
              { label:'⚖️ Evaluar mi riesgo',     msg:'Evalúa el riesgo de mi cartera y dime si estoy sobreexpuesto' },
              { label:'🧾 Optimización fiscal',   msg:'Analiza mi cartera desde el punto de vista fiscal y ayúdame a optimizar impuestos' },
              { label:'🧮 Simulador',             msg:'Quiero hacer una simulación de inversión' },
            ] as { label:string; msg:string }[]).map(chip => (
              <button key={chip.label} onClick={() => send(chip.msg)}
                style={{ background:'transparent', border:`1px solid ${C.gold}55`, borderRadius:20, padding:'5px 12px', color:C.goldL, fontSize:'.72em', cursor:'pointer', fontFamily:"'Sora',sans-serif", transition:'all .16s', letterSpacing:'.2px' }}
                onMouseEnter={e=>{ (e.currentTarget.style.background=`${C.gold}18`); (e.currentTarget.style.borderColor=C.gold); }}
                onMouseLeave={e=>{ (e.currentTarget.style.background='transparent'); (e.currentTarget.style.borderColor=`${C.gold}55`); }}>
                {chip.label}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div style={{ padding:'12px 18px 16px', borderTop:`1px solid ${C.border}`, background:C.surf, flexShrink:0 }}>
        {file && (
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, padding:'6px 10px', background:'#111128', border:'1px solid #2a2a50', borderRadius:8, fontSize:'.74em', color:C.gold }}>
            📎 {file.name}
            <button onClick={()=>setFile(null)} style={{ background:'transparent', border:'none', color:C.muted, cursor:'pointer', marginLeft:'auto' }}>✕</button>
          </div>
        )}
        <div style={{ display:'flex', gap:8, alignItems:'flex-end', background:C.surf2, border:`1px solid ${input||file?'#2a2a50':C.border}`, borderRadius:13, padding:'9px 12px', transition:'border-color .2s', boxShadow:input?`0 0 0 2px ${C.gold}08`:'none' }}>
          <button onClick={()=>fileRef.current?.click()} style={{ background:'transparent', border:'none', color:C.muted, cursor:'pointer', fontSize:'1.1em', padding:'0 2px', flexShrink:0 }} title="Adjuntar imagen o PDF">📎</button>
          <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display:'none' }} onChange={handleFile} />
          <textarea ref={taRef} value={input} rows={1}
            onChange={e=>{setInput(e.target.value);e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,120)+'px';}}
            onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}}
            placeholder="Pregunta lo que quieras… (Enter para enviar)"
            style={{ flex:1, background:'transparent', border:'none', outline:'none', color:C.text, fontSize:'.86em', resize:'none', fontFamily:"'Sora',sans-serif", lineHeight:1.55, maxHeight:120 }}
          />
          <button className="send-btn" onClick={()=>send()} disabled={loading||(!input.trim()&&!file)}
            style={{ width:33, height:33, borderRadius:9, background:(input.trim()||file)&&!loading?C.gold:'#1a1a2a', border:'none', cursor:'pointer', color:(input.trim()||file)&&!loading?'#07070e':C.faint, transition:'all .18s', flexShrink:0, fontWeight:700, fontSize:'1.05em' }}>↑</button>
        </div>
      </div>

      {showMem && <MemoryPanel onClose={()=>setShowMem(false)} />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   PORTFOLIO TAB
══════════════════════════════════════════════════════════════ */
const IMPORT_SYSTEM = `Eres un parser de carteras de inversión. Extrae todas las posiciones del texto/imagen proporcionado.
Responde SOLO con JSON válido (sin texto, sin backticks):
[{"ticker":"AAPL","name":"Apple Inc.","shares":10,"avgPrice":150.00,"currentPrice":185.00},...]
- ticker: símbolo bursátil en mayúsculas (dedúcelo del nombre si no aparece explícito)
- shares: número de acciones/participaciones (puede ser decimal)
- avgPrice: precio medio de compra en EUR
- currentPrice: precio actual en EUR (si no aparece, usa avgPrice)
Si no hay posiciones válidas, responde: []`;

const PLANES_SYSTEM = `Extrae los planes de inversión periódicos de la imagen o el texto.

Cada fila de la lista es un plan. Suele traer: el nombre de lo que se compra, cada cuánto, y el importe de cada compra.

Devuelve SOLO un array JSON, sin explicaciones ni bloques de código:
[{"ticker":"","name":"Core MSCI World USD (Acc)","amount":10,"frecuencia":"mensual"}]

- **name** es lo importante y nunca puede faltar: cópialo tal cual aparece.
- **ticker** es opcional. Si la pantalla no lo enseña, déjalo como cadena vacía. NO te lo inventes ni lo deduzcas del nombre.
- **amount** es el importe de cada aportación: el número que lleva el símbolo de moneda (10 €, 50,00 €). Ignora cualquier otro número de la fila — los contadores de días que faltan para la próxima compra, los porcentajes o los totales acumulados NO son el importe.
- **frecuencia**: "semanal", "quincenal", "mensual" o "trimestral", según lo que ponga la fila.
- Incluye TODAS las filas de la lista, aunque se repita el mismo importe.
- Si de verdad no hay ninguna lista de planes, devuelve [].`;

/** Lee los planes periódicos de una captura del broker, igual que la cartera. */
async function parsePlanesWithAI(
  text?: string,
  imageB64?: string,
  imageType?: string,
): Promise<PlanInversion[]> {
  const content: unknown[] = [];
  if (imageB64 && imageType) {
    content.push({ type:'image', source:{ type:'base64', media_type:imageType, data:imageB64 } });
  }
  content.push({ type:'text', text: text || 'Extrae los planes de inversión periódicos de esta imagen.' });

  const raw = await callProvider(
    { provider: 'gemini', model: MODELO_DE_AJUSTES,
      fallback: { provider: 'anthropic', model: 'claude-sonnet-5' } },
    [{ role:'user', content }],
    PLANES_SYSTEM,
    undefined, 2048, false,
  );

  const json = raw.replace(/```[a-z]*\n?|```/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('No he podido leer los planes de esa imagen. Prueba con una captura más nítida.');
  }
  if (!Array.isArray(parsed)) parsed = [];

  const planes = (parsed as unknown[])
    .map((p, i) => normalizarPlan(p as Record<string, unknown>, i))
    .filter((p): p is PlanInversion => p !== null);

  // Si la IA devolvió algo y aquí no sobrevivió nada, el problema está en esta
  // casa y no en la captura. Enseñar lo que llegó convierte el misterio en algo
  // que se puede mirar, en vez de mandar al usuario a repetir la foto.
  if (!planes.length && json && json !== '[]') {
    throw new PlanesIlegibles(json.slice(0, 600));
  }
  return planes;
}

/** La IA respondió, pero no se ha podido convertir en planes. */
class PlanesIlegibles extends Error {
  constructor(public readonly crudo: string) {
    super('He leído algo, pero no he sabido convertirlo en planes.');
  }
}

async function parsePortfolioWithAI(
  text?: string,
  imageB64?: string,
  imageType?: string,
): Promise<Position[]> {
  const content: unknown[] = [];
  if (imageB64 && imageType) {
    content.push({ type:'image', source:{ type:'base64', media_type:imageType, data:imageB64 } });
  }
  content.push({ type:'text', text: text || 'Extrae las posiciones de esta imagen de cartera.' });

  // Importar cartera es puro reconocimiento de imagen: si el usuario tiene
  // Gemini configurado se hace ahi, y si no vuelve a Claude sola.
  //
  // El tope era de 512 tokens, que llegaba para una cartera de ejemplo y se
  // quedaba corto para una de verdad: la respuesta se cortaba a media posicion
  // y el JSON incompleto reventaba al leerlo, en mitad del analisis. Con 4096
  // caben del orden de ochenta posiciones.
  const raw = await callProvider(
    { provider: 'gemini', model: MODELO_DE_AJUSTES,
      fallback: { provider: 'anthropic', model: 'claude-sonnet-5' } },
    [{ role:'user', content }],
    IMPORT_SYSTEM,
    undefined, 4096, false, // sin busqueda web
  );
  const json = raw.replace(/```[a-z]*\n?|```/g, '').trim();

  let parsed: any[];
  try {
    parsed = JSON.parse(json) as any[];
  } catch {
    // Una respuesta cortada empieza bien y acaba a medias. Decirlo asi da algo
    // que hacer —repetir por partes— en vez de un error de sintaxis.
    if (json.startsWith('[') && !json.trimEnd().endsWith(']')) {
      throw new Error(
        'La cartera es más larga de lo que cabe en una respuesta. Prueba a importarla '
        + 'en dos capturas: lo importado se suma, no se reemplaza.',
      );
    }
    throw new Error('No he podido leer las posiciones de esa imagen. Prueba con una captura más nítida.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('No he podido leer las posiciones de esa imagen.');
  }
  return parsed.map((p, i) => ({
    id: Date.now() + i,
    ticker: String(p.ticker || '?').toUpperCase(),
    name: String(p.name || p.ticker || '?'),
    shares: +p.shares || 0,
    avgPrice: +p.avgPrice || 0,
    currentPrice: +p.currentPrice || +p.avgPrice || 0,
  })).filter(p => p.ticker !== '?' && p.shares > 0);
}

function ImportModal({ onImport, onClose, imagenInicial }:{
  onImport:(p:Position[])=>void;
  onClose:()=>void;
  /** Captura que llega compartida desde el móvil: se abre con ella puesta. */
  imagenInicial?: { b64:string; type:string; preview:string } | null;
}) {
  const [tab,       setTab]     = useState<'paste'|'image'>(imagenInicial ? 'image' : 'paste');
  const [text,      setText]    = useState('');
  const [image,     setImage]   = useState<{ b64:string; type:string; preview:string }|null>(imagenInicial ?? null);
  const [parsing,   setParsing] = useState(false);
  const [preview,   setPreview] = useState<Position[]|null>(null);
  const [error,     setError]   = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const loadImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setImage({ b64: result.split(',')[1], type: f.type, preview: result });
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  };

  // Con el importador abierto, el botón atrás lo cierra en vez de salir de la
  // aplicación: lo de arriba se cierra primero.
  useEffect(() => atras.registrar(onClose), [onClose]);

  // Recortar la pantalla deja la imagen en el portapapeles, así que el gesto
  // natural es pegarla aquí — no guardarla en un fichero y volver a buscarla.
  // Esto es lo que sustituye a integrar un navegador dentro de la aplicación:
  // el navegador se queda donde está y solo viaja la captura.
  useEffect(() => {
    const alPegar = (e: ClipboardEvent) => {
      const archivo = Array.from(e.clipboardData?.items ?? [])
        .find(i => i.type.startsWith('image/'))?.getAsFile();
      if (!archivo) return;
      e.preventDefault();
      const lector = new FileReader();
      lector.onload = () => {
        const resultado = lector.result as string;
        setImage({ b64: resultado.split(',')[1], type: archivo.type, preview: resultado });
        setTab('image');
        setError('');
      };
      lector.readAsDataURL(archivo);
    };
    window.addEventListener('paste', alPegar);
    return () => window.removeEventListener('paste', alPegar);
  }, []);

  const parse = async () => {
    setParsing(true); setError(''); setPreview(null);
    try {
      const positions = await parsePortfolioWithAI(
        tab === 'paste' ? text : undefined,
        tab === 'image' ? image?.b64 : undefined,
        tab === 'image' ? image?.type : undefined,
      );
      if (!positions.length) { setError('No se encontraron posiciones. Intenta con más detalle.'); }
      else setPreview(positions);
    } catch(e:any) { setError(`Error: ${e.message}`); }
    finally { setParsing(false); }
  };

  const canParse = tab==='paste' ? text.trim().length > 10 : !!image;

  return (
    <div style={{ position:'fixed', inset:0, background:'#00000088', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:C.surf, border:`1px solid ${C.border}`, borderRadius:16, width:'100%', maxWidth:560, maxHeight:'85vh', overflow:'auto', boxShadow:'0 24px 64px #00000099' }}>
        {/* Header */}
        <div style={{ padding:'16px 20px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:'.88em', fontWeight:600, color:C.goldL }}>Importar cartera con IA</div>
            <div style={{ fontSize:'.65em', color:C.muted, marginTop:2 }}>Pega una captura con Ctrl+V, o el texto de tus posiciones</div>
          </div>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:C.muted, cursor:'pointer', fontSize:'1.1em' }}>✕</button>
        </div>

        <div style={{ padding:'18px 20px', display:'flex', flexDirection:'column', gap:16 }}>
          {/* Tabs */}
          <div style={{ display:'flex', gap:8 }}>
            {([['paste','📋 Pegar texto'],['image','🖼 Captura de pantalla']] as const).map(([t,l]) => (
              <button key={t} onClick={() => setTab(t)}
                style={{ flex:1, padding:'8px', borderRadius:9, background:tab===t?`${C.gold}18`:C.surf2, border:`1px solid ${tab===t?C.gold+'44':C.border}`, color:tab===t?C.gold:C.muted, cursor:'pointer', fontSize:'.75em', fontFamily:"'Sora',sans-serif" }}>
                {l}
              </button>
            ))}
          </div>

          {/* Instructions */}
          <div style={{ background:'#0a0a1a', border:`1px solid ${C.border}`, borderRadius:9, padding:'10px 13px', fontSize:'.7em', color:C.muted, lineHeight:1.6 }}>
            {tab==='paste'
              ? <>En <strong style={{ color:C.text }}>Trade Republic</strong>: abre la app → Cartera → selecciona y copia el texto con todas las posiciones.<br/>También funciona con <strong style={{ color:C.text }}>DEGIRO, eToro, Indexa, MyInvestor</strong> y cualquier broker.</>
              : <>Haz una captura de pantalla de tu cartera en cualquier broker y súbela aquí. Claude leerá las posiciones directamente de la imagen.</>
            }
          </div>

          {/* Input */}
          {tab==='paste' ? (
            <textarea value={text} onChange={e=>setText(e.target.value)} rows={7}
              placeholder={"Pega aquí el texto de tu cartera...\n\nEjemplo (Trade Republic):\nApple Inc.\nAAPL · 10 acc.\nValor: 1.850 €  Precio medio: 150,00 €\n\nVanguard FTSE All-World\nVWCE · 5 acc.\nValor: 940 €  Precio medio: 110,00 €"}
              style={{ background:C.surf2, border:`1px solid ${C.border2}`, borderRadius:9, padding:'10px 13px', color:C.text, fontSize:'.8em', resize:'vertical', fontFamily:"'DM Mono',monospace", lineHeight:1.6, outline:'none', width:'100%' }}
            />
          ) : (
            <div>
              <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }} onChange={loadImage} />
              {image ? (
                <div style={{ position:'relative' }}>
                  <img src={image.preview} alt="preview" style={{ width:'100%', borderRadius:9, border:`1px solid ${C.border}`, maxHeight:200, objectFit:'contain', background:'#000' }} />
                  <button onClick={() => setImage(null)} style={{ position:'absolute', top:6, right:6, background:'#00000099', border:'none', color:'#fff', borderRadius:6, padding:'3px 8px', cursor:'pointer', fontSize:'.72em' }}>✕ Cambiar</button>
                </div>
              ) : (
                <button onClick={() => fileRef.current?.click()}
                  style={{ width:'100%', padding:'28px', background:C.surf2, border:`2px dashed ${C.border2}`, borderRadius:9, color:C.muted, cursor:'pointer', fontSize:'.8em', display:'flex', flexDirection:'column', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:'2em' }}>🖼</span>
                  <span>Haz clic para subir la captura</span>
                  <span style={{ fontSize:'.85em', opacity:.6 }}>PNG, JPG, WebP</span>
                </button>
              )}
            </div>
          )}

          {/* Parse button */}
          <button onClick={parse} disabled={!canParse || parsing}
            style={{ padding:'10px', background:canParse&&!parsing?C.gold:'#1a1a28', border:'none', borderRadius:9, color:canParse&&!parsing?'#07070e':C.muted, fontWeight:600, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
            {parsing ? <><Spinner /> Claude está leyendo tu cartera…</> : '✨ Analizar con IA'}
          </button>

          {error && <div style={{ color:C.red, fontSize:'.75em', padding:'8px 12px', background:'#2a0a0a', borderRadius:8, border:`1px solid ${C.red}33` }}>{error}</div>}

          {/* Preview */}
          {preview && preview.length > 0 && (
            <div>
              <div style={{ fontSize:'.68em', color:C.muted, letterSpacing:'1px', textTransform:'uppercase', marginBottom:8 }}>Posiciones detectadas · {preview.length}</div>
              <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:9, overflow:'hidden', marginBottom:12 }}>
                {preview.map((p,i) => (
                  <div key={i} style={{ display:'grid', gridTemplateColumns:'70px 1fr 55px 70px 70px', gap:8, padding:'9px 14px', borderBottom:`1px solid ${C.border}22`, fontSize:'.78em', alignItems:'center' }}>
                    <span style={{ color:C.gold, fontWeight:600, fontFamily:"'DM Mono',monospace" }}>{p.ticker}</span>
                    <span style={{ color:C.muted, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}</span>
                    <span style={{ color:C.muted, fontFamily:"'DM Mono',monospace" }}>{p.shares}</span>
                    <span style={{ color:C.muted, fontFamily:"'DM Mono',monospace" }}>{p.avgPrice}€</span>
                    <span style={{ color:C.text,  fontFamily:"'DM Mono',monospace" }}>{p.currentPrice}€</span>
                  </div>
                ))}
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={() => onImport(preview)}
                  style={{ flex:1, padding:'10px', background:C.green, border:'none', borderRadius:9, color:'#07070e', fontWeight:600, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif" }}>
                  ✓ Importar {preview.length} posiciones
                </button>
                <button onClick={() => setPreview(null)}
                  style={{ padding:'10px 16px', background:'transparent', border:`1px solid ${C.border}`, borderRadius:9, color:C.muted, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif" }}>
                  Editar
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── SellModal ─────────────────────────────────────────────────── */
function SellModal({ pos, onClose }:{ pos:Position; onClose:()=>void }) {
  const [amount,   setAmount]   = useState('');
  const [result,   setResult]   = useState<string|null>(null);
  const [loading,  setLoading]  = useState(false);
  const [mode,     setMode]     = useState<'real'|'chat'>(() => {
    // Si conocemos el ISIN, ofrecer venta real; si no, sugerir chat
    return ISIN_MAP[pos.ticker.toUpperCase()] ? 'real' : 'chat';
  });

  const isin = ISIN_MAP[pos.ticker.toUpperCase()];
  const totalShares = pos.shares;
  const sellEur = amount === '100%'
    ? totalShares * pos.currentPrice
    : (parseFloat(amount) || 0);
  const sellShares = amount === '100%' ? totalShares : (sellEur / pos.currentPrice) || 0;

  const handleSell = async () => {
    if (loading) return;
    setLoading(true); setResult(null);
    try {
      const cfg = await getBackendConfig();
      if (!cfg) {
        setResult('⚠️ Configura el backend en Ajustes → Servidor para operar en tiempo real.');
        return;
      }
      if (!isin) {
        setResult(`ℹ️ ISIN de ${pos.ticker} no reconocido. Usa el chat:\n"vende ${amount||'todas las'} acciones de ${pos.ticker}"`);
        return;
      }

      const body = {
        trades: [{
          ticker: pos.ticker,
          isin,
          name:   pos.name,
          amount: amount === '100%' ? 0 : sellEur,
          shares: amount === '100%' ? totalShares : 0,
        }],
        notify: true,
      };
      const res = await backendCall(cfg, '/sell', 'POST', body);
      const r   = res.results?.[0];
      if (r?.status === 'executed') {
        setResult(`✅ Venta ejecutada\nOrden ID: ${r.orderId || '—'}`);
      } else {
        setResult(`❌ Error: ${r?.error || 'Respuesta inesperada del broker'}`);
      }
    } catch(e:any) {
      setResult(`❌ ${e?.message || String(e)}`);
    } finally { setLoading(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(7,7,14,.82)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2000 }} onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div style={{ background:C.surf2, border:`1px solid ${C.border2}`, borderRadius:14, padding:'22px 26px', width:380, maxWidth:'94vw', boxShadow:'0 16px 60px #00000099' }}>
        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <div>
            <span style={{ fontSize:'.6em', letterSpacing:'1.5px', color:C.muted, textTransform:'uppercase' }}>Vender posición</span>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:3 }}>
              <span style={{ fontSize:'1.1em', fontWeight:700, color:C.red, fontFamily:"'DM Mono',monospace" }}>{pos.ticker}</span>
              {isin && <span style={{ fontSize:'.6em', color:C.faint, fontFamily:"'DM Mono',monospace" }}>{isin}</span>}
              {!isin && <span style={{ fontSize:'.65em', color:'#e8734a', background:'rgba(232,115,74,.12)', padding:'2px 7px', borderRadius:5 }}>ISIN no mapeado</span>}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'transparent', border:'none', color:C.muted, cursor:'pointer', fontSize:'1.1em' }}>✕</button>
        </div>

        {/* Position info */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:16 }}>
          {[
            { l:'Acciones', v:`${totalShares}` },
            { l:'Precio actual', v:`${pos.currentPrice.toFixed(2)}€` },
            { l:'Valor total', v:`${(totalShares*pos.currentPrice).toFixed(0)}€` },
          ].map(({ l, v }) => (
            <div key={l} style={{ background:'#0a0a18', borderRadius:8, padding:'8px 10px' }}>
              <div style={{ fontSize:'.58em', color:C.faint, marginBottom:2 }}>{l}</div>
              <div style={{ fontSize:'.8em', fontWeight:600, color:C.text, fontFamily:"'DM Mono',monospace" }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Mode tabs */}
        <div style={{ display:'flex', gap:6, marginBottom:14 }}>
          {[
            { id:'real', label:'🏦 Venta real', disabled:!isin },
            { id:'chat', label:'💬 Usar chat',  disabled:false },
          ].map(t => (
            <button key={t.id} onClick={()=>!t.disabled&&setMode(t.id as 'real'|'chat')} disabled={t.disabled}
              style={{ flex:1, padding:'6px 0', borderRadius:8, border:`1px solid ${mode===t.id?C.red+'55':C.border}`, background:mode===t.id?`${C.red}12`:'transparent', color:mode===t.id?C.red:t.disabled?C.faint:C.muted, cursor:t.disabled?'not-allowed':'pointer', fontSize:'.72em', fontFamily:"'Sora',sans-serif", opacity:t.disabled?.45:1 }}>
              {t.label}
            </button>
          ))}
        </div>

        {mode === 'real' ? (
          <>
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:'.62em', color:C.muted, marginBottom:5 }}>Importe (€) · "100%" para vender todo</div>
              <input value={amount} onChange={e=>setAmount(e.target.value)} placeholder="ej: 500 o 100%"
                style={{ ...inputBase, padding:'9px 12px', fontSize:'.84em' }}
                onKeyDown={e=>{ if(e.key==='Enter') handleSell(); }} />
              {sellEur > 0 && (
                <div style={{ fontSize:'.65em', color:C.faint, marginTop:4 }}>
                  ≈ {sellShares.toFixed(4)} acc. · {sellEur.toFixed(2)}€
                </div>
              )}
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={handleSell} disabled={loading||!amount.trim()}
                style={{ flex:1, padding:'10px', background:loading||!amount.trim()?'#1a1a28':C.red, border:'none', borderRadius:9, color:loading||!amount.trim()?C.muted:'#fff', fontWeight:700, cursor:loading||!amount.trim()?'not-allowed':'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', justifyContent:'center', gap:7 }}>
                {loading ? <><Spinner/> Enviando orden…</> : `Vender ${amount?amount:'—'}`}
              </button>
              <button onClick={onClose} style={{ padding:'10px 16px', background:'transparent', border:`1px solid ${C.border}`, borderRadius:9, color:C.muted, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif" }}>✕</button>
            </div>
          </>
        ) : (
          <div style={{ background:'#0a0a1a', border:`1px solid ${C.border}`, borderRadius:9, padding:'12px 14px', fontSize:'.75em', color:C.muted, lineHeight:1.7 }}>
            Escribe en el chat:<br/>
            <code style={{ color:C.gold, fontFamily:"'DM Mono',monospace" }}>
              vende {amount||'500'} € de {pos.ticker}
            </code><br/>
            AURUM interpretará la orden y la ejecutará con confirmación.
          </div>
        )}

        {result && (
          <div style={{ marginTop:12, padding:'10px 14px', background: result.startsWith('✅')?`${C.green}0a`:'#0a0a18', border:`1px solid ${result.startsWith('✅')?C.green+'33':C.border2}`, borderRadius:9, fontSize:'.76em', color:result.startsWith('✅')?C.green:C.text, lineHeight:1.6, whiteSpace:'pre-line' }}>
            {result}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Mapas estáticos: divisa y dividendo estimado por ticker ── */
const CURRENCY_MAP: Record<string, string> = {
  // ETFs cotizados en EUR (divisa de cotización, no necesariamente de los activos)
  VWCE:'EUR', XEON:'EUR', SPPW:'EUR', SGLN:'EUR', EUNL:'EUR', VUSA:'EUR',
  BTCE:'EUR', WGLD:'EUR', IEMA:'EUR', ZPRV:'EUR', IS3N:'EUR', QDVE:'EUR',
  AGGU:'EUR', XDWD:'EUR', IWDA:'EUR', EXXT:'EUR', VHYL:'EUR', IBTS:'EUR',
  // Acciones US (cotizan en USD)
  AAPL:'USD', MSFT:'USD', NVDA:'USD', AMZN:'USD', GOOGL:'USD', TSLA:'USD',
  META:'USD', NFLX:'USD', ORCL:'USD',
  // Acciones EU
  ASML:'EUR', SAP:'EUR', LVMH:'EUR', SAN:'EUR', IBE:'EUR', ITX:'EUR',
};

// Rentabilidad por dividendo anual estimada (%)
const YIELD_MAP: Record<string, number> = {
  VWCE:1.5, VHYL:3.2, EUNL:1.8, XEON:3.8, AGGU:3.5, SPPW:1.3,
  XDWD:1.8, IWDA:1.8, IEMA:2.1, SGLN:0, BTCE:0, IS3N:3.0,
  AAPL:0.5, MSFT:0.7, NVDA:0.03, AMZN:0, GOOGL:0, TSLA:0,
  META:0.4, NFLX:0, ORCL:1.2,
  SAN:4.2, IBE:5.1, ITX:3.8, ASML:0.8, SAP:1.2, LVMH:2.0,
};

/* ── Feature 1: Tax Harvesting Card ──────────────────────────── */
function TaxCard({ portfolio }: { portfolio: Position[] }) {
  const result = taxLossOpportunities(portfolio);
  if (!result.losers.length) return null;
  return (
    <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:12, padding:'14px 17px', marginBottom:14 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
        <span style={{ fontSize:'.82em', fontWeight:600, color:C.goldL }}>🧾 Tax Harvesting</span>
        <span style={{ fontSize:'.65em', padding:'2px 8px', borderRadius:20, background:`${C.green}18`, border:`1px solid ${C.green}44`, color:C.green, fontFamily:"'DM Mono',monospace" }}>
          −{Math.abs(result.total).toLocaleString('es-ES')}€ · ahorra {result.savings.toLocaleString('es-ES')}€ en IRPF
        </span>
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:5, marginBottom:10 }}>
        {result.losers.map((l) => (
          <div key={l.ticker} style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 10px', background:'#0a0a18', borderRadius:8, border:`1px solid ${C.border}` }}>
            <span style={{ color:C.gold, fontWeight:600, fontFamily:"'DM Mono',monospace", fontSize:'.82em', minWidth:60 }}>{l.ticker}</span>
            <span style={{ color:C.red, fontFamily:"'DM Mono',monospace", fontSize:'.78em' }}>{l.lossPct}%</span>
            <span style={{ color:C.red, fontFamily:"'DM Mono',monospace", fontSize:'.78em', marginLeft:'auto' }}>{l.loss.toLocaleString('es-ES')}€</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize:'.68em', color:C.muted, fontStyle:'italic', lineHeight:1.5 }}>{result.advice}</div>
    </div>
  );
}

/* ── Feature 3: Price Alerts helpers ────────────────────────── */
interface PriceAlert { ticker: string; above?: number; below?: number; active: boolean; }
const ALERTS_KEY = 'aurum-price-alerts';

function loadPriceAlerts(): PriceAlert[] {
  return store.get<PriceAlert[]>(ALERTS_KEY, []);
}
function savePriceAlerts(alerts: PriceAlert[]) {
  store.set(ALERTS_KEY, alerts);
}

/* ── PortfolioSidePanel — Distribución / Divisas / Dividendos ─ */
function PortfolioSidePanel({ portfolio, totalVal, chartData }:{ portfolio:Position[]; totalVal:number; chartData:{name:string;value:number}[] }) {
  const [tab, setTab] = useState<'dist'|'fx'|'div'>('dist');

  // Divisas
  const fxGroups: Record<string, number> = {};
  portfolio.forEach(p => {
    const cur = CURRENCY_MAP[p.ticker.toUpperCase()] || 'EUR';
    fxGroups[cur] = (fxGroups[cur] || 0) + p.shares * p.currentPrice;
  });
  const fxData = Object.entries(fxGroups).map(([name, value]) => ({ name, value: +value.toFixed(0) }));
  const FX_COLORS: Record<string,string> = { EUR:C.gold, USD:C.blue, GBP:'#9b6cf6', CHF:C.green };

  // Dividendos
  const divRows = portfolio
    .map(p => {
      const y = YIELD_MAP[p.ticker.toUpperCase()] ?? null;
      if (y === null) return null;
      const val   = p.shares * p.currentPrice;
      const annual = val * y / 100;
      return { ticker: p.ticker, yield: y, annual };
    })
    .filter(Boolean) as { ticker:string; yield:number; annual:number }[];
  const totalDiv = divRows.reduce((a, r) => a + r.annual, 0);
  const portYield = totalVal ? totalDiv / totalVal * 100 : 0;

  const TABS = [
    { id:'dist', label:'Distribución' },
    { id:'fx',   label:'Divisas'      },
    { id:'div',  label:'Dividendos'   },
  ] as const;

  return (
    <Card style={{ padding:'14px 16px' }}>
      {/* Tab bar */}
      <div style={{ display:'flex', gap:4, marginBottom:12 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ flex:1, background: tab===t.id ? `${C.gold}18` : 'transparent', border:`1px solid ${tab===t.id ? C.gold+'44' : C.border}`, borderRadius:7, padding:'4px 0', cursor:'pointer', fontSize:'.6em', color: tab===t.id ? C.goldL : C.muted, fontFamily:"'Sora',sans-serif", fontWeight: tab===t.id ? 600 : 400, transition:'all .15s' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Distribución */}
      {tab === 'dist' && <>
        <ResponsiveContainer width="100%" height={160}>
          <PieChart>
            <Pie data={chartData} cx="50%" cy="50%" innerRadius={44} outerRadius={72} paddingAngle={2} dataKey="value">
              {chartData.map((_,i)=><Cell key={i} fill={PIE_PAL[i%PIE_PAL.length]} />)}
            </Pie>
            <Tooltip formatter={(v:any)=>[`${v.toLocaleString('es-ES')}€`]} contentStyle={{ background:C.surf3, border:`1px solid ${C.border}`, borderRadius:8, fontSize:'.76em', color:C.text }}/>
          </PieChart>
        </ResponsiveContainer>
        <div style={{ display:'flex', flexDirection:'column', gap:4, marginTop:6 }}>
          {chartData.map((d,i)=>(
            <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:'.7em' }}>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <div style={{ width:8, height:8, borderRadius:2, background:PIE_PAL[i%PIE_PAL.length], flexShrink:0 }}/>
                <span style={{ color:C.muted }}>{d.name}</span>
              </div>
              <span style={{ color:C.text, fontFamily:"'DM Mono',monospace" }}>{totalVal?(d.value/totalVal*100).toFixed(1):0}%</span>
            </div>
          ))}
        </div>
      </>}

      {/* Divisas */}
      {tab === 'fx' && <>
        <ResponsiveContainer width="100%" height={160}>
          <PieChart>
            <Pie data={fxData} cx="50%" cy="50%" innerRadius={44} outerRadius={72} paddingAngle={3} dataKey="value">
              {fxData.map((d,i)=><Cell key={i} fill={FX_COLORS[d.name] || PIE_PAL[i]} />)}
            </Pie>
            <Tooltip formatter={(v:any)=>[`${v.toLocaleString('es-ES')}€`]} contentStyle={{ background:C.surf3, border:`1px solid ${C.border}`, borderRadius:8, fontSize:'.76em', color:C.text }}/>
          </PieChart>
        </ResponsiveContainer>
        <div style={{ display:'flex', flexDirection:'column', gap:4, marginTop:6 }}>
          {fxData.map((d,i)=>(
            <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:'.7em' }}>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <div style={{ width:8, height:8, borderRadius:2, background:FX_COLORS[d.name]||PIE_PAL[i], flexShrink:0 }}/>
                <span style={{ color:C.muted }}>{d.name}</span>
              </div>
              <div style={{ textAlign:'right' }}>
                <span style={{ color:C.text, fontFamily:"'DM Mono',monospace" }}>{totalVal?(d.value/totalVal*100).toFixed(1):0}%</span>
                <span style={{ color:C.faint, fontFamily:"'DM Mono',monospace", fontSize:'.85em', marginLeft:6 }}>{d.value.toLocaleString('es-ES',{maximumFractionDigits:0})}€</span>
              </div>
            </div>
          ))}
        </div>
      </>}

      {/* Dividendos */}
      {tab === 'div' && <>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
          <div style={{ padding:'8px 10px', background:`${C.green}0a`, border:`1px solid ${C.green}33`, borderRadius:8 }}>
            <div style={{ fontSize:'.58em', color:C.faint, marginBottom:2 }}>Ingresos anuales</div>
            <div style={{ fontSize:'.9em', fontWeight:700, color:C.green, fontFamily:"'DM Mono',monospace" }}>{totalDiv.toLocaleString('es-ES',{maximumFractionDigits:0})}€</div>
          </div>
          <div style={{ padding:'8px 10px', background:`${C.gold}0a`, border:`1px solid ${C.gold}33`, borderRadius:8 }}>
            <div style={{ fontSize:'.58em', color:C.faint, marginBottom:2 }}>Yield cartera</div>
            <div style={{ fontSize:'.9em', fontWeight:700, color:C.gold, fontFamily:"'DM Mono',monospace" }}>{portYield.toFixed(2)}%</div>
          </div>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          {divRows.length === 0
            ? <div style={{ fontSize:'.7em', color:C.faint }}>Sin datos de dividendos para las posiciones actuales.</div>
            : divRows.sort((a,b)=>b.annual-a.annual).map(r => (
              <div key={r.ticker} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', background:'#0a0a18', borderRadius:7 }}>
                <span style={{ color:C.gold, fontWeight:600, fontFamily:"'DM Mono',monospace", fontSize:'.78em', minWidth:50 }}>{r.ticker}</span>
                <span style={{ color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:'.72em' }}>{r.yield.toFixed(1)}%</span>
                <span style={{ color:C.green, fontFamily:"'DM Mono',monospace", fontSize:'.75em', marginLeft:'auto' }}>+{r.annual.toLocaleString('es-ES',{maximumFractionDigits:0})}€/año</span>
              </div>
            ))
          }
        </div>
        <div style={{ fontSize:'.6em', color:C.faint, marginTop:8, fontStyle:'italic' }}>Estimación basada en yield histórico. Los dividendos pasados no garantizan futuros.</div>
      </>}
    </Card>
  );
}

/* ── Score AURUM ─────────────────────────────────────────────── */
function calcAurumScore(portfolio: Position[], profile: string) {
  if (!portfolio.length) return null;
  const drift   = detectDrift(portfolio, profile);
  const risk    = portfolioRiskScore(portfolio);
  const tax     = taxLossOpportunities(portfolio);
  const totalVal  = portfolio.reduce((a,p) => a + p.shares * p.currentPrice, 0);
  const totalCost = portfolio.reduce((a,p) => a + p.shares * p.avgPrice, 0);
  const pnlPct    = totalCost ? (totalVal - totalCost) / totalCost * 100 : 0;

  // 5 dimensiones (100 pts total)
  const s1 = Math.max(0, Math.round(25 - drift.driftPct * 2.5));            // Alineación perfil  /25
  const s2 = Math.min(20, Math.round(portfolio.length * 2.5));              // Diversificación    /20
  const s3 = (() => {                                                        // Riesgo vs perfil   /20
    if (profile==='agresivo'    && risk.score >= 65) return 20;
    if (profile==='moderado'    && risk.score >= 35 && risk.score <= 65) return 20;
    if (profile==='conservador' && risk.score <= 35) return 20;
    return Math.max(0, 20 - Math.abs(risk.score - (profile==='agresivo'?75:profile==='moderado'?50:25)) / 2);
  })();
  const s4 = Math.min(20, Math.max(0, Math.round(10 + pnlPct * 0.5)));     // Rendimiento        /20
  const s5 = Math.max(0, Math.round(15 - (tax.savings / Math.max(totalVal,1)) * 500)); // Fiscal /15

  const total = Math.min(100, s1 + s2 + Math.round(s3) + s4 + s5);
  const grade = total >= 85 ? 'A+' : total >= 75 ? 'A' : total >= 65 ? 'B' : total >= 50 ? 'C' : total >= 35 ? 'D' : 'F';
  const color = total >= 70 ? C.green : total >= 50 ? C.gold : C.red;
  return {
    total, grade, color,
    dims: [
      { label:'Alineación',    score:s1,            max:25 },
      { label:'Diversif.',     score:s2,             max:20 },
      { label:'Riesgo',        score:Math.round(s3), max:20 },
      { label:'Rendimiento',   score:s4,             max:20 },
      { label:'Fiscal',        score:s5,             max:15 },
    ],
  };
}

/**
 * Planes de inversión periódicos.
 *
 * La cartera dice lo que tienes; esto dice hacia dónde va. Sin ello el consejo
 * va cojo: no es lo mismo tener 800 € en un ETF que tener 800 € y estar
 * metiendo 100 al mes, aunque la foto de hoy sea la misma.
 */
function PlanesCard({ planes, setPlanes }: {
  planes: PlanInversion[];
  setPlanes: (p: PlanInversion[]) => void;
}) {
  const [importando, setImportando] = useState(false);
  const [anadiendo,  setAnadiendo]  = useState(false);
  const [nuevo,      setNuevo]      = useState({ name:'', amount:'', frecuencia:'mensual' });
  const [error,      setError]      = useState<string|null>(null);
  const [crudo,      setCrudo]      = useState<string|null>(null);
  const [cargando,   setCargando]   = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const guardar = async (siguientes: PlanInversion[]) => {
    setPlanes(siguientes);
    await sSet(CLAVE_PLANES, siguientes);
  };

  const leer = async (b64: string, tipo: string) => {
    setCargando(true); setError(null); setCrudo(null);
    try {
      const leidos = await parsePlanesWithAI(undefined, b64, tipo);
      if (!leidos.length) {
        setError('No he encontrado planes periódicos ahí. Asegúrate de que la captura sea '
          + 'la pantalla de planes de inversión del broker, no la de posiciones.');
        return;
      }
      await guardar([...planes, ...leidos]);
      setImportando(false);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      if (e?.crudo) setCrudo(String(e.crudo));
    } finally {
      setCargando(false);
    }
  };

  const anadirAMano = async () => {
    const plan = normalizarPlan({ name: nuevo.name, amount: nuevo.amount, frecuencia: nuevo.frecuencia });
    if (!plan) { setError('Hace falta un nombre y un importe.'); return; }
    setError(null);
    await guardar([...planes, plan]);
    setNuevo({ name:'', amount:'', frecuencia:'mensual' });
    setAnadiendo(false);
  };

  const desdeFichero = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const lector = new FileReader();
    lector.onload = () => {
      const r = lector.result as string;
      void leer(r.split(',')[1], f.type);
    };
    lector.readAsDataURL(f);
    e.target.value = '';
  };

  // Pegar la captura con Ctrl+V, igual que en la cartera.
  useEffect(() => {
    if (!importando) return;
    const alPegar = (e: ClipboardEvent) => {
      const archivo = Array.from(e.clipboardData?.items ?? [])
        .find(i => i.type.startsWith('image/'))?.getAsFile();
      if (!archivo) return;
      e.preventDefault();
      const lector = new FileReader();
      lector.onload = () => {
        const r = lector.result as string;
        void leer(r.split(',')[1], archivo.type);
      };
      lector.readAsDataURL(archivo);
    };
    window.addEventListener('paste', alPegar);
    return () => window.removeEventListener('paste', alPegar);
  }, [importando, planes]);

  const mensual = Math.round(aportacionMensual(planes));

  return (
    <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'14px 18px', marginBottom:14 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.1em', fontWeight:600, color:C.goldL }}>
            Planes de inversión
          </div>
          <div style={{ fontSize:'.68em', color:C.muted, marginTop:2 }}>
            {planes.length
              ? `${planes.length} ${planes.length === 1 ? 'plan' : 'planes'} · ~${mensual.toLocaleString('es-ES')} €/mes`
              : 'Lo que compras cada mes sin pensarlo. AURUM lo tendrá en cuenta al aconsejarte.'}
          </div>
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <button onClick={() => { setImportando(v => !v); setAnadiendo(false); setError(null); }}
            style={{ background: importando ? 'transparent' : 'rgba(201,168,76,.12)', border:`1px solid ${importando ? C.border : C.gold + '44'}`, color: importando ? C.muted : C.gold, borderRadius:8, padding:'6px 14px', cursor:'pointer', fontSize:'.74em', fontFamily:"'Sora',sans-serif", whiteSpace:'nowrap' }}>
            {importando ? '✕ Cancelar' : '✨ Importar de captura'}
          </button>
          <button onClick={() => { setAnadiendo(v => !v); setImportando(false); setError(null); }}
            style={{ background:'transparent', border:`1px solid ${C.border2}`, color:C.muted, borderRadius:8, padding:'6px 14px', cursor:'pointer', fontSize:'.74em', fontFamily:"'Sora',sans-serif", whiteSpace:'nowrap' }}>
            {anadiendo ? '✕ Cancelar' : '+ Añadir a mano'}
          </button>
        </div>
      </div>

      {importando && (
        <div style={{ marginTop:12, padding:'14px', border:`1px dashed ${C.border2}`, borderRadius:10, textAlign:'center' }}>
          <div style={{ fontSize:'.72em', color:C.muted, lineHeight:1.6, marginBottom:10 }}>
            Haz una captura de la pantalla de planes de tu broker y <strong style={{ color:C.text }}>pégala con Ctrl+V</strong>,
            o súbela desde aquí.
          </div>
          <input ref={fileRef} type="file" accept="image/*" onChange={desdeFichero} style={{ display:'none' }} />
          <button onClick={() => fileRef.current?.click()} disabled={cargando}
            style={{ background:'transparent', border:`1px solid ${C.border2}`, color:C.muted, borderRadius:8, padding:'6px 14px', cursor:'pointer', fontSize:'.72em', fontFamily:"'Sora',sans-serif" }}>
            {cargando ? 'Leyendo…' : 'Elegir imagen'}
          </button>
        </div>
      )}

      {anadiendo && (
        <div style={{ marginTop:12, display:'grid', gridTemplateColumns:'2fr 1fr 1fr auto', gap:8, alignItems:'end' }}>
          <div>
            <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>Qué compras</div>
            <input value={nuevo.name} onChange={e => setNuevo({ ...nuevo, name: e.target.value })}
              placeholder="Core MSCI World" style={{ ...inputBase, padding:'7px 10px' }} />
          </div>
          <div>
            <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>Cuánto</div>
            <input value={nuevo.amount} onChange={e => setNuevo({ ...nuevo, amount: e.target.value })}
              placeholder="10 €" style={{ ...inputBase, padding:'7px 10px' }}
              onKeyDown={e => e.key === 'Enter' && void anadirAMano()} />
          </div>
          <div>
            <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>Cada</div>
            <select value={nuevo.frecuencia} onChange={e => setNuevo({ ...nuevo, frecuencia: e.target.value })}
              style={{ ...inputBase, padding:'7px 10px', cursor:'pointer' }}>
              <option value="semanal">semana</option>
              <option value="quincenal">quincena</option>
              <option value="mensual">mes</option>
              <option value="trimestral">trimestre</option>
            </select>
          </div>
          <button onClick={anadirAMano}
            style={{ background:C.gold, border:'none', borderRadius:8, padding:'7px 14px', color:'#07070e', fontWeight:600, cursor:'pointer', fontSize:'.74em', fontFamily:"'Sora',sans-serif" }}>
            Añadir
          </button>
        </div>
      )}

      {error && <div style={{ marginTop:10, fontSize:'.72em', color:C.red }}>{error}</div>}

      {crudo && (
        <div style={{ marginTop:8 }}>
          <div style={{ fontSize:'.66em', color:C.muted, marginBottom:5 }}>Esto es lo que leyó:</div>
          <pre style={{ margin:0, padding:'8px 10px', background:C.surf, border:`1px solid ${C.border}`, borderRadius:8, fontSize:'.64em', color:C.muted, overflow:'auto', maxHeight:180, whiteSpace:'pre-wrap' }}>{crudo}</pre>
        </div>
      )}

      {planes.length > 0 && (
        <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:6 }}>
          {planes.map(p => (
            <div key={p.id} style={{ display:'flex', alignItems:'center', gap:10, fontSize:'.74em' }}>
              <span style={{ color:C.gold, fontFamily:"'DM Mono',monospace", fontWeight:600, minWidth:70 }}>{p.ticker}</span>
              <span style={{ color:C.muted, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}</span>
              <span style={{ color:C.text, fontFamily:"'DM Mono',monospace" }}>{p.amount}€</span>
              <span style={{ color:C.muted, fontSize:'.9em' }}>{p.frecuencia}</span>
              <button onClick={() => void guardar(planes.filter(x => x.id !== p.id))}
                title="Quitar este plan"
                style={{ background:'transparent', border:'none', color:C.faint, cursor:'pointer', fontSize:'.9em', padding:'0 2px' }}>
                ✕
              </button>
            </div>
          ))}

          {/* Sin esto la lista se queda ahí sin explicar qué aporta tenerla. */}
          <div style={{ marginTop:6, paddingTop:10, borderTop:`1px solid ${C.border}`, fontSize:'.68em', color:C.muted, lineHeight:1.55 }}>
            AURUM cuenta con estos {Math.round(aportacionMensual(planes)).toLocaleString('es-ES')} €/mes
            en todo lo que te aconseje: al revisar tu cartera, al proponerte dónde poner dinero nuevo
            y cuando le preguntes en el chat. Así no te propone aportar algo que ya estás aportando.
          </div>
        </div>
      )}
    </div>
  );
}

interface ContextoIndice {
  key: string; name: string;
  desdeMaximoPct: number; periodoPct: number;
  volatilidadPct: number; posicionEnRango: number;
}

/**
 * Revisión: ¿se parece la cartera a lo que dijiste que querías?
 *
 * La puntuación de aquí abajo compara contra la plantilla del perfil de riesgo,
 * que no sabe nada de tus planes. Esto compara contra lo que escribiste. Los
 * números van calculados de antemano para que la IA no invente ninguno: lo que
 * se le pide es el juicio, no la aritmética.
 */
function RevisionCard({ portfolio, profile, userProfile, planes }: {
  portfolio: Position[];
  profile: string;
  userProfile: UserProfile;
  planes: PlanInversion[];
}) {
  const [texto,    setTexto]    = useState<string|null>(null);
  const [cargando, setCargando] = useState(false);
  const [error,    setError]    = useState<string|null>(null);
  const [mercado,  setMercado]  = useState<ContextoIndice[]|null>(null);

  const avisos = useMemo(
    () => calcularAvisos(portfolio, profile, userProfile.notes || ''),
    [portfolio, profile, userProfile.notes],
  );

  if (!portfolio.length) return null;

  const revisar = async () => {
    setCargando(true); setError(null);
    try {
      const drift  = detectDrift(portfolio, profile);
      const riesgo = portfolioRiskScore(portfolio);
      const fiscal = taxLossOpportunities(portfolio);
      const valor  = portfolio.reduce((a, p) => a + p.shares * p.currentPrice, 0);
      const coste  = portfolio.reduce((a, p) => a + p.shares * p.avgPrice, 0);

      const hechos = [
        `Valor actual: ${Math.round(valor).toLocaleString('es-ES')} EUR`,
        `Invertido: ${Math.round(coste).toLocaleString('es-ES')} EUR`,
        `Resultado: ${coste ? (((valor - coste) / coste) * 100).toFixed(1) : '0'}%`,
        '',
        formatDrift(drift),
        '',
        `Riesgo de la cartera: ${riesgo.score}/100`,
        '',
        formatTaxLoss(fiscal),
        '',
        'Posiciones:',
        ...portfolio.map(p => `- ${p.ticker} (${p.name}): ${p.shares} x ${p.currentPrice}€, comprado a ${p.avgPrice}€`),
      ].join('\n');

      // Contexto de mercado: cuentas sobre los cierres de los ultimos meses. Se
      // le dan hechas para que la IA razone sobre ellas en vez de opinar sobre
      // el mercado de memoria, que es donde empieza a sonar segura sin serlo.
      let bloqueMercado = '';
      try {
        const { contexto } = await apiFetch<{ contexto: ContextoIndice[] }>('/api/market-contexto');
        setMercado(contexto);
        bloqueMercado = '\n\nContexto de mercado (últimos 6 meses, calculado):\n'
          + contexto.map(c =>
              `- ${c.name}: ${c.desdeMaximoPct}% desde su máximo, ${c.periodoPct >= 0 ? '+' : ''}${c.periodoPct}% en el periodo, `
              + `volatilidad ${c.volatilidadPct}%, está al ${c.posicionEnRango}% de su rango`,
            ).join('\n');
      } catch {
        // Sin contexto se revisa igual: la cartera y los planes son lo esencial.
      }

      const bloqueDePlanes = bloquePlanes(planes);
      const escritos = (userProfile.notes || '').trim();
      const pregunta = escritos
        ? `Mis planes:\n${planes}\n\nMis números:\n${hechos}${bloqueMercado}`
        : `No he escrito mis planes todavía.\n\nMis números:\n${hechos}${bloqueMercado}`;

      const respuesta = await callProvider(
        { provider: 'gemini', model: MODELO_DE_AJUSTES,
          fallback: { provider: 'anthropic', model: 'claude-sonnet-5' } },
        [{ role: 'user', content: pregunta }],
        REVISION_SYSTEM,
        undefined, 1500, false,
      );
      setTexto(respuesta);
      void sSet('aurum-ultima-revision', { fecha: Date.now(), texto: respuesta });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setCargando(false);
    }
  };

  return (
    <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'14px 18px', marginBottom:14 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.1em', fontWeight:600, color:C.goldL }}>
            ¿Lo estoy haciendo bien?
          </div>
          <div style={{ fontSize:'.68em', color:C.muted, marginTop:2 }}>
            AURUM compara tu cartera con lo que dijiste que querías.
          </div>
        </div>
        <button onClick={revisar} disabled={cargando}
          style={{ background: cargando ? `${C.gold}44` : C.gold, border:'none', borderRadius:9, padding:'8px 16px', color:'#07070e', fontWeight:600, cursor: cargando ? 'default' : 'pointer', fontSize:'.76em', fontFamily:"'Sora',sans-serif", whiteSpace:'nowrap' }}>
          {cargando ? 'Revisando…' : 'Revisar ahora'}
        </button>
      </div>

      {avisos.length > 0 && (
        <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:8 }}>
          {avisos.map(a => (
            <div key={a.id} style={{ background: a.gravedad === 'atencion' ? `${C.gold}0e` : C.surf, border:`1px solid ${a.gravedad === 'atencion' ? C.gold + '44' : C.border}`, borderRadius:9, padding:'9px 12px' }}>
              <div style={{ fontSize:'.74em', color:C.text, fontWeight:600 }}>{a.titulo}</div>
              <div style={{ fontSize:'.68em', color:C.muted, marginTop:3, lineHeight:1.5 }}>{a.detalle}</div>
            </div>
          ))}
        </div>
      )}

      {mercado && mercado.length > 0 && (
        <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${C.border}` }}>
          <div style={{ fontSize:'.64em', color:C.muted, marginBottom:6, letterSpacing:'.5px', textTransform:'uppercase' }}>
            Dónde está el mercado · 6 meses
          </div>
          <div style={{ display:'flex', gap:14, flexWrap:'wrap' }}>
            {mercado.map(c => (
              <div key={c.key} style={{ fontSize:'.68em', color:C.muted }}>
                <span style={{ color:C.text }}>{c.name}</span>{' '}
                <span style={{ color: c.desdeMaximoPct <= -10 ? C.gold : C.muted, fontFamily:"'DM Mono',monospace" }}>
                  {c.desdeMaximoPct}% del máx
                </span>{' · '}
                <span style={{ fontFamily:"'DM Mono',monospace" }}>vol {c.volatilidadPct}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <div style={{ marginTop:10, fontSize:'.72em', color:C.red }}>{error}</div>}

      {texto && (
        <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${C.border}`, fontSize:'.76em', color:C.text, lineHeight:1.65 }}>
          <Md text={texto} />
        </div>
      )}
    </div>
  );
}

function AurumScoreCard({ portfolio, profile }: { portfolio: Position[]; profile: string }) {
  const [open, setOpen] = useState(false);
  const sc = calcAurumScore(portfolio, profile);
  if (!sc) return null;

  return (
    <div style={{ background:C.surf2, border:`1px solid ${sc.color}33`, borderRadius:13, padding:'14px 18px', marginBottom:14, cursor:'pointer' }} onClick={() => setOpen(v=>!v)}>
      <div style={{ display:'flex', alignItems:'center', gap:14 }}>
        {/* Big score */}
        <div style={{ textAlign:'center', flexShrink:0 }}>
          <div style={{ fontSize:'2.4em', fontWeight:800, color:sc.color, fontFamily:"'DM Mono',monospace", lineHeight:1, textShadow:`0 0 20px ${sc.color}66` }}>{sc.total}</div>
          <div style={{ fontSize:'.62em', color:sc.color, fontFamily:"'DM Mono',monospace", letterSpacing:'1px', marginTop:2 }}>/{100}</div>
        </div>
        {/* Grade + label */}
        <div style={{ flex:1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
            <span style={{ fontSize:'1.1em', fontWeight:700, color:sc.color, fontFamily:"'Cormorant Garamond',serif" }}>Score AURUM</span>
            <span style={{ padding:'2px 8px', borderRadius:20, background:`${sc.color}18`, border:`1px solid ${sc.color}44`, color:sc.color, fontSize:'.68em', fontFamily:"'DM Mono',monospace", fontWeight:700 }}>{sc.grade}</span>
          </div>
          {/* Mini bar */}
          <div style={{ height:5, background:C.border, borderRadius:3, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${sc.total}%`, background:`linear-gradient(90deg,${sc.color}99,${sc.color})`, borderRadius:3, transition:'width .6s ease', boxShadow:`0 0 10px ${sc.color}55` }} />
          </div>
        </div>
        <span style={{ color:C.faint, fontSize:'.7em' }}>{open?'▲':'▼'}</span>
      </div>

      {/* Breakdown */}
      {open && (
        <div style={{ marginTop:14, display:'flex', flexDirection:'column', gap:7 }}>
          {sc.dims.map(d => {
            const pct = d.score / d.max * 100;
            const col = pct >= 75 ? C.green : pct >= 50 ? C.gold : C.red;
            return (
              <div key={d.label}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                  <span style={{ fontSize:'.68em', color:C.muted }}>{d.label}</span>
                  <span style={{ fontSize:'.68em', color:col, fontFamily:"'DM Mono',monospace" }}>{d.score}/{d.max}</span>
                </div>
                <div style={{ height:4, background:C.border, borderRadius:2, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${pct}%`, background:col, borderRadius:2, transition:'width .4s ease' }} />
                </div>
              </div>
            );
          })}
          <div style={{ fontSize:'.62em', color:C.faint, marginTop:4, lineHeight:1.5, fontStyle:'italic' }}>
            {sc.total >= 70 ? '✓ Cartera bien gestionada. Sigue el plan.' : sc.total >= 50 ? '⚠ Hay margen de mejora. Consulta a AURUM.' : '⚡ Cartera desalineada. Actúa ahora.'}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Goals Tracker ───────────────────────────────────────────── */
const GOALS_KEY = 'aurum-goal';
interface Goal { target: number; label: string; startValue: number; startDate: string; }

function GoalsCard({ totalVal }: { totalVal: number }) {
  const [goal,     setGoal]     = useState<Goal|null>(() => store.get<Goal|null>(GOALS_KEY, null));
  const [editing,  setEditing]  = useState(false);
  const [tInput,   setTInput]   = useState('');
  const [lInput,   setLInput]   = useState('');

  const save = (target: number, label: string) => {
    const g: Goal = { target, label, startValue: totalVal, startDate: new Date().toISOString().slice(0,10) };
    setGoal(g);
    store.set(GOALS_KEY, g);
    setEditing(false);
  };
  const remove = () => { setGoal(null); store.remove(GOALS_KEY); };

  if (!goal && !editing) return (
    <button onClick={() => setEditing(true)}
      style={{ background:'transparent', border:`1px dashed ${C.border2}`, borderRadius:10, padding:'10px 14px', cursor:'pointer', fontSize:'.72em', color:C.faint, width:'100%', marginBottom:14, fontFamily:"'Sora',sans-serif", textAlign:'left' }}>
      🎯 Añadir objetivo financiero…
    </button>
  );

  if (editing) return (
    <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:10, padding:'14px 16px', marginBottom:14 }}>
      <div style={{ fontSize:'.68em', color:C.goldL, fontWeight:600, marginBottom:10 }}>🎯 Nuevo objetivo</div>
      <div style={{ display:'flex', gap:8, marginBottom:8 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:'.6em', color:C.muted, marginBottom:3 }}>Capital objetivo (€)</div>
          <input type="number" value={tInput} onChange={e=>setTInput(e.target.value)} placeholder="100000" style={{ ...inputBase, padding:'7px 10px', fontSize:'.82em' }} />
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:'.6em', color:C.muted, marginBottom:3 }}>Etiqueta</div>
          <input type="text" value={lInput} onChange={e=>setLInput(e.target.value)} placeholder="Jubilación, casa..." style={{ ...inputBase, padding:'7px 10px', fontSize:'.82em' }} />
        </div>
      </div>
      <div style={{ display:'flex', gap:8 }}>
        <button onClick={() => { const t = parseFloat(tInput); if (t > 0) save(t, lInput || 'Objetivo'); }}
          style={{ background:C.gold, border:'none', borderRadius:8, padding:'7px 16px', color:'#07070e', fontWeight:700, cursor:'pointer', fontSize:'.78em', fontFamily:"'Sora',sans-serif" }}>Guardar</button>
        <button onClick={() => setEditing(false)}
          style={{ background:'transparent', border:`1px solid ${C.border2}`, borderRadius:8, padding:'7px 12px', color:C.muted, cursor:'pointer', fontSize:'.78em', fontFamily:"'Sora',sans-serif" }}>Cancelar</button>
      </div>
    </div>
  );

  const pct     = Math.min(totalVal / goal!.target * 100, 100);
  const missing = Math.max(goal!.target - totalVal, 0);
  const gained  = totalVal - goal!.startValue;
  const color   = pct >= 100 ? C.green : pct >= 60 ? C.gold : C.blue;

  return (
    <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:10, padding:'14px 16px', marginBottom:14 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <div style={{ fontSize:'.72em', fontWeight:600, color:C.goldL }}>🎯 {goal!.label}</div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <span style={{ fontSize:'.65em', color:color, fontFamily:"'DM Mono',monospace", fontWeight:700 }}>{pct.toFixed(1)}%</span>
          <button onClick={() => setEditing(true)} style={{ background:'transparent', border:'none', color:C.faint, cursor:'pointer', fontSize:'.75em' }}>✎</button>
          <button onClick={remove} style={{ background:'transparent', border:'none', color:C.faint, cursor:'pointer', fontSize:'.75em' }}>✕</button>
        </div>
      </div>
      {/* Barra de progreso */}
      <div style={{ height:6, background:C.border, borderRadius:3, marginBottom:10, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${pct}%`, background:color, borderRadius:3, transition:'width .4s ease', boxShadow:`0 0 8px ${color}66` }} />
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
        {[
          { l:'Actual',   v:`${totalVal.toLocaleString('es-ES',{maximumFractionDigits:0})}€`,    c:C.text  },
          { l:'Objetivo', v:`${goal!.target.toLocaleString('es-ES',{maximumFractionDigits:0})}€`, c:C.muted },
          { l:pct>=100?'Conseguido':'Faltan', v:`${missing>0?missing.toLocaleString('es-ES',{maximumFractionDigits:0})+'€':'🎉'}`, c:pct>=100?C.green:C.red },
        ].map(({l,v,c})=>(
          <div key={l} style={{ textAlign:'center' }}>
            <div style={{ fontSize:'.58em', color:C.faint, marginBottom:2 }}>{l}</div>
            <div style={{ fontSize:'.78em', fontWeight:600, color:c, fontFamily:"'DM Mono',monospace" }}>{v}</div>
          </div>
        ))}
      </div>
      {gained !== 0 && (
        <div style={{ marginTop:8, fontSize:'.65em', color: gained>=0?C.green:C.red, textAlign:'center' }}>
          {gained>=0?'▲':'▼'} {Math.abs(gained).toLocaleString('es-ES',{maximumFractionDigits:0})}€ desde que creaste el objetivo ({goal!.startDate})
        </div>
      )}
    </div>
  );
}

function PortfolioTab({ portfolio, setPortfolio, profile, userProfile }:{ portfolio:Position[]; setPortfolio:(p:Position[])=>void; profile:string; userProfile:UserProfile }) {
  const [planes, setPlanes] = useState<PlanInversion[]>([]);
  useEffect(() => { void sGet<PlanInversion[]>(CLAVE_PLANES).then(p => { if (p) setPlanes(p); }); }, []);
  const empty = { ticker:'', name:'', shares:'', avgPrice:'', currentPrice:'' };
  const [form, setForm]       = useState(empty);
  const [adding, setAdding]   = useState(false);
  const [upd, setUpd]         = useState(false);
  const [importing, setImporting] = useState(false);
  const [capturaCompartida, setCapturaCompartida] = useState<{ b64:string; type:string; preview:string }|null>(null);
  const [falloCompartir, setFalloCompartir] = useState<string|null>(null);

  // Una captura compartida desde el móvil abre el importador con ella dentro.
  // Se mira al montar y también con la pantalla ya abierta, porque compartir
  // con la aplicación en marcha no vuelve a pasar por aquí.
  useEffect(() => {
    const recoger = () => {
      const fallo = compartido.tomarFallo();
      if (fallo) { setFalloCompartir(fallo); return; }
      const captura = compartido.tomar();
      if (!captura) return;
      setFalloCompartir(null);
      setCapturaCompartida({
        b64: captura.b64,
        type: captura.tipo,
        preview: `data:${captura.tipo};base64,${captura.b64}`,
      });
      setImporting(true);
    };
    recoger();
    window.addEventListener(compartido.EVENTO_CAPTURA, recoger);
    return () => window.removeEventListener(compartido.EVENTO_CAPTURA, recoger);
  }, []);
  const [lastRefresh, setLastRefresh] = useState<Date|null>(null);
  const [portHistory, setPortHistory] = useState<{ date:string; value:number }[]>([]);
  const [sellPos,  setSellPos]  = useState<Position|null>(null);
  const [trSync,   setTrSync]   = useState<'idle'|'loading'|'ok'|'error'>('idle');
  const [trSyncMsg, setTrSyncMsg] = useState('');
  // Feature 3: Price alerts
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>(() => loadPriceAlerts());
  const [alertInput,  setAlertInput]  = useState<{ ticker:string; above:string; below:string } | null>(null);

  // Reverse ISIN_MAP para lookup ticker por ISIN (datos vivos de TR)
  const TICKER_BY_ISIN: Record<string,string> = Object.fromEntries(
    Object.entries(ISIN_MAP).map(([ticker, isin]) => [isin, ticker])
  );

  const syncFromTR = async () => {
    const cfg = await getBackendConfig();
    if (!cfg) { setTrSyncMsg('Sin backend. Configura en Ajustes.'); setTrSync('error'); return; }
    setTrSync('loading'); setTrSyncMsg('');
    try {
      const data = await backendCall(cfg, '/portfolio');
      const raw: {isin:string;name:string;shares:number;avg_price:number;current_price:number}[] = data.positions || [];
      if (!raw.length) { setTrSyncMsg('TR devolvió cartera vacía'); setTrSync('ok'); return; }
      const imported: Position[] = raw.map((p, i) => ({
        id:           Date.now() + i,
        ticker:       TICKER_BY_ISIN[p.isin] || p.isin.slice(0, 6).toUpperCase(),
        name:         p.name,
        shares:       p.shares,
        avgPrice:     p.avg_price,
        currentPrice: p.current_price,
      }));
      await save(imported);
      setTrSync('ok');
      setTrSyncMsg(`${imported.length} posiciones sincronizadas de TR`);
      setLastRefresh(new Date());
      setTimeout(() => { setTrSync('idle'); setTrSyncMsg(''); }, 5000);
    } catch(e:any) {
      setTrSync('error');
      setTrSyncMsg(e?.message || String(e));
      setTimeout(() => { setTrSync('idle'); setTrSyncMsg(''); }, 7000);
    }
  };

  const totalVal  = portfolio.reduce((a,p)=>a+p.shares*p.currentPrice,0);
  const totalCost = portfolio.reduce((a,p)=>a+p.shares*p.avgPrice,0);
  const pnl       = totalVal - totalCost;
  const pnlPct    = totalCost ? pnl/totalCost*100 : 0;

  // Estado de permisos de notificación del navegador
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );
  const requestNotifPerm = async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    setNotifPerm(p);
  };

  // Export cartera a CSV
  const exportCSV = () => {
    if (!portfolio.length) return;
    const header = 'Ticker,Nombre,Acciones,P.Compra,P.Actual,P&L EUR,P&L %\n';
    const rows = portfolio.map(p => {
      const pnlVal = ((p.currentPrice - p.avgPrice) * p.shares).toFixed(2);
      const pnlPct = ((p.currentPrice - p.avgPrice) / p.avgPrice * 100).toFixed(2);
      return `${p.ticker},"${p.name.replace(/"/g,'""')}",${p.shares},${p.avgPrice},${p.currentPrice},${pnlVal},${pnlPct}`;
    }).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `aurum-cartera-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const save = async (updated:Position[]) => { setPortfolio(updated); await sSet('aurum-portfolio', updated); };
  const add  = async () => {
    if (!form.ticker||!form.shares||!form.avgPrice) return;
    await save([...portfolio, { id:Date.now(), ticker:form.ticker.toUpperCase().trim(), name:form.name||form.ticker.toUpperCase().trim(), shares:+form.shares, avgPrice:+form.avgPrice, currentPrice:+(form.currentPrice||form.avgPrice) }]);
    setForm(empty); setAdding(false);
  };
  const remove = (id:number) => save(portfolio.filter(p=>p.id!==id));

  // Auto-refresh al montar si hay posiciones (máx cada 5 min para no gastar tokens)
  useEffect(() => {
    if (!portfolio.length) return;
    const doRefresh = async () => {
      const now = Date.now();
      const stored = await sGet('aurum-price-refresh-ts');
      if (stored && now - stored < 5 * 60 * 1000) return; // cooldown 5 min
      setUpd(true);
      try {
        const prices = await nexusPrices(portfolio.map(p => p.ticker));
        if (prices.length) {
          const updated = portfolio.map(p => {
            const f = prices.find(x => x.ticker?.toUpperCase() === p.ticker);
            return f ? { ...p, currentPrice: f.price } : p;
          });
          await save(updated);
          await sSet('aurum-price-refresh-ts', now);
          setLastRefresh(new Date());
        }
      } catch { /* silencioso */ } finally { setUpd(false); }
    };
    doRefresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Portfolio value history — snapshot once per day
  useEffect(() => {
    const HIST_KEY = 'aurum-portfolio-history';
    const today = new Date().toISOString().slice(0, 10);
    sGet(HIST_KEY).then((saved: { date:string; value:number }[] | null) => {
      const hist: { date:string; value:number }[] = Array.isArray(saved) ? saved : [];
      setPortHistory(hist.slice(-30));
      if (hist.length > 0 && hist[hist.length - 1].date === today) return; // already snapshotted today
      const val = portfolio.reduce((a, p) => a + p.shares * p.currentPrice, 0);
      if (val === 0) return;
      const updated = [...hist, { date: today, value: +val.toFixed(2) }].slice(-365);
      sSet(HIST_KEY, updated);
      setPortHistory(updated.slice(-30));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPrices = async () => {
    if (!portfolio.length) return;
    setUpd(true);
    try {
      const prices = await nexusPrices(portfolio.map(p=>p.ticker));
      if (prices.length) {
        const updated = portfolio.map(p => { const f=prices.find(x=>x.ticker?.toUpperCase()===p.ticker); return f?{...p,currentPrice:f.price}:p; });
        await save(updated);
        await sSet('aurum-price-refresh-ts', Date.now());
        setLastRefresh(new Date());
        // Feature 3: check price alerts
        const currentAlerts = loadPriceAlerts();
        const triggeredAlerts = currentAlerts.filter(a => {
          const pos = updated.find(p => p.ticker === a.ticker);
          if (!pos || !a.active) return false;
          if (a.above !== undefined && pos.currentPrice >= a.above) return true;
          if (a.below !== undefined && pos.currentPrice <= a.below) return true;
          return false;
        });
        if (triggeredAlerts.length) {
          triggeredAlerts.forEach(a => {
            const pos = updated.find(p => p.ticker === a.ticker);
            if (!pos) return;
            const body = `${a.ticker} cotiza a ${pos.currentPrice.toFixed(2)}€${a.above !== undefined && pos.currentPrice >= a.above ? ` (superó ${a.above}€)` : ''}${a.below !== undefined && pos.currentPrice <= a.below ? ` (bajó de ${a.below}€)` : ''}`;
            addAlert({
              type:     'price_alert' as any,
              severity: 'warning',
              title:    `🔔 Alerta de precio: ${a.ticker}`,
              body,
              actionable: false,
            });
            // Browser notification nativa si el usuario la ha concedido
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              try { new Notification(`🔔 AURUM · ${a.ticker}`, { body, icon: '/favicon.ico', tag: `price-${a.ticker}` }); } catch {}
            }
          });
          // Deactivate triggered alerts
          const nextAlerts = currentAlerts.map(a => triggeredAlerts.find(t => t.ticker === a.ticker) ? { ...a, active: false } : a);
          savePriceAlerts(nextAlerts);
          setPriceAlerts(nextAlerts);
        }
      }
    } finally { setUpd(false); }
  };

  const chartData = portfolio.map(p=>({ name:p.ticker, value:+(p.shares*p.currentPrice).toFixed(0) }));
  const fmtEur = (n:number) => n.toLocaleString('es-ES',{maximumFractionDigits:0})+'€';
  const statCard = (label:string, val:string, color:string, sub?:string) => (
    <div className="card-h" style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:12, padding:'14px 17px', transition:'border-color .2s' }}>
      <div style={{ fontSize:'.6em', letterSpacing:'1.5px', color:C.muted, textTransform:'uppercase', marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:'1.18em', fontWeight:600, color:color||C.text, fontFamily:"'DM Mono',monospace" }}>{val}</div>
      {sub && <div style={{ fontSize:'.65em', color:C.faint, marginTop:3 }}>{sub}</div>}
    </div>
  );
  const fieldStyle:React.CSSProperties = { ...inputBase, padding:'7px 10px' };

  return (
    <div style={{ padding:'18px 20px', overflow:'auto', height:'100%' }}>
      {portHistory.length >= 2 && (
        <div style={{ marginBottom:14, padding:'12px 16px', background:C.surf2, border:`1px solid ${C.border}`, borderRadius:12, display:'flex', alignItems:'center', gap:16 }}>
          <div>
            <div style={{ fontSize:'.58em', letterSpacing:'1.5px', color:C.muted, textTransform:'uppercase', marginBottom:2 }}>Historial 30d</div>
            <div style={{ fontSize:'.78em', color:C.goldL, fontFamily:"'DM Mono',monospace" }}>
              {portHistory.length} días
            </div>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={portHistory} margin={{ top:6, right:4, left:4, bottom:0 }}>
                <defs>
                  <linearGradient id="pgGold" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.gold} stopOpacity={0.45}/>
                    <stop offset="100%" stopColor={C.gold} stopOpacity={0.02}/>
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="value" stroke={C.gold} strokeWidth={1.5} fill="url(#pgGold)" dot={false} isAnimationActive={false}/>
                <Tooltip
                  contentStyle={{ background:C.surf3, border:`1px solid ${C.border}`, borderRadius:8, fontSize:'.7em', color:C.text }}
                  formatter={(v:any)=>[`${Number(v).toLocaleString('es-ES',{maximumFractionDigits:0})}€`, 'Valor']}
                  labelStyle={{ color:C.muted, fontSize:'.65em' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:16 }}>
        {statCard('Valor total', fmtEur(totalVal), C.goldL, totalCost?`coste ${fmtEur(totalCost)}`:'sin posiciones')}
        {statCard('P&L total', `${pnl>=0?'+':''}${fmtEur(pnl)}`, pnl>=0?C.green:C.red)}
        {statCard('Rendimiento', `${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%`, pnlPct>=0?C.green:C.red)}
      </div>
      {/* Score AURUM */}
      <PlanesCard planes={planes} setPlanes={setPlanes} />
      <RevisionCard portfolio={portfolio} profile={profile} userProfile={userProfile} planes={planes} />
      <AurumScoreCard portfolio={portfolio} profile={profile} />
      {/* Goals tracker */}
      <GoalsCard totalVal={totalVal} />
      {/* Feature 1: Tax Harvesting Card */}
      <TaxCard portfolio={portfolio} />
      <div style={{ display:'grid', gridTemplateColumns:portfolio.length?'1fr 220px':'1fr', gap:14, alignItems:'start' }}>
        <Card>
          {/* La fila entera envuelve: antes solo lo hacia el grupo de botones, y
              en movil la etiqueta quedaba apretada contra ellos. */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8, padding:'12px 16px', borderBottom:`1px solid ${C.border}` }}>
            <span style={{ fontSize:'.65em', letterSpacing:'1.5px', color:C.muted, textTransform:'uppercase', flexShrink:0 }}>Posiciones · {portfolio.length}</span>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              {trSyncMsg && (
                <span style={{ fontSize:'.65em', color:trSync==='ok'?C.green:trSync==='error'?C.red:C.muted }}>
                  {trSync==='ok'?'✓ ':trSync==='error'?'❌ ':''}{trSyncMsg}
                </span>
              )}
              <button onClick={syncFromTR} disabled={trSync==='loading'}
                style={{ background:'transparent', border:`1px solid ${C.green}55`, color:trSync==='loading'?C.muted:C.green, borderRadius:7, padding:'4px 10px', cursor:trSync==='loading'?'not-allowed':'pointer', fontSize:'.7em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', gap:5, transition:'all .15s' }}
                title="Importar posiciones reales desde Trade Republic (requiere backend autenticado)">
                {trSync==='loading'?<Spinner/>:'📲'} {trSync==='loading'?'Sincronizando…':'Sincronizar TR'}
              </button>
              <button onClick={refreshPrices} disabled={!portfolio.length||upd}
                style={{ background:'transparent', border:`1px solid ${C.border2}`, color:upd?C.muted:C.gold, borderRadius:7, padding:'4px 10px', cursor:'pointer', fontSize:'.7em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', gap:5 }}>
                {upd?<Spinner/>:'↻'} {upd?'Actualizando…':'Actualizar precios'}
                {lastRefresh && !upd && <span style={{ color:C.faint, fontSize:'.85em' }}>· {lastRefresh.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}</span>}
              </button>
              {notifPerm === 'default' && (
                <button onClick={requestNotifPerm}
                  title="Recibe notificaciones del navegador cuando tus alertas de precio se disparen"
                  style={{ background:'rgba(201,168,76,.08)', border:`1px solid ${C.gold}33`, color:C.gold, borderRadius:7, padding:'4px 10px', cursor:'pointer', fontSize:'.7em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', gap:5 }}>
                  🔔 Activar notif.
                </button>
              )}
              {portfolio.length > 0 && (
                <button onClick={exportCSV}
                  title="Descargar cartera como CSV"
                  style={{ background:'transparent', border:`1px solid ${C.border2}`, color:C.muted, borderRadius:7, padding:'4px 10px', cursor:'pointer', fontSize:'.7em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', gap:5 }}>
                  ⬇ CSV
                </button>
              )}
              {/* El botón grande vive en la pantalla vacía, así que en cuanto
                  hay una posición desaparece y este era el único camino — pero
                  pequeño, azul y perdido entre otros cinco. Con posiciones pasa
                  a ser el mismo dorado que «Añadir», que es su hermano. */}
              <button onClick={()=>setImporting(true)}
                title="Añade más posiciones desde una captura o pegando texto"
                style={{ background: portfolio.length ? 'rgba(201,168,76,.12)' : 'rgba(91,156,246,.1)', border:`1px solid ${portfolio.length ? C.gold + '44' : '#5b9cf644'}`, color: portfolio.length ? C.gold : C.blue, borderRadius:7, padding:'4px 10px', cursor:'pointer', fontSize:'.7em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', gap:5 }}>
                {portfolio.length ? '✨ Importar más' : '✨ Importar IA'}
              </button>
              <button onClick={()=>setAdding(v=>!v)}
                style={{ background:adding?C.faint+'22':'rgba(201,168,76,.12)', border:`1px solid ${adding?C.border:C.gold+'44'}`, color:adding?C.muted:C.gold, borderRadius:7, padding:'4px 10px', cursor:'pointer', fontSize:'.7em', fontFamily:"'Sora',sans-serif" }}>
                {adding?'✕ Cancelar':'+ Añadir'}
              </button>
            </div>
          </div>
          {adding && (
            <div style={{ padding:'14px 16px', background:'#0a0a18', borderBottom:`1px solid ${C.border}` }}>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:8, marginBottom:10 }}>
                {([['ticker','Ticker','AAPL'],['name','Nombre','Apple Inc.'],['shares','Acciones','10'],['avgPrice','P.Compra €','150'],['currentPrice','P.Actual €','185']] as [keyof typeof empty,string,string][]).map(([k,l,ph])=>(
                  <div key={k}>
                    <div style={{ fontSize:'.6em', color:C.muted, marginBottom:3 }}>{l}</div>
                    <input value={form[k]} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))} placeholder={ph} style={fieldStyle} onKeyDown={e=>e.key==='Enter'&&add()} />
                  </div>
                ))}
              </div>
              <button onClick={add} style={{ background:C.gold, border:'none', borderRadius:8, padding:'7px 18px', color:'#07070e', fontWeight:600, cursor:'pointer', fontSize:'.78em', fontFamily:"'Sora',sans-serif" }}>Añadir posición</button>
            </div>
          )}
          {/* Compartir algo y que no pase nada es la peor respuesta posible:
              si Android no dejó leer la imagen, aquí se dice y se ofrece salida. */}
          {falloCompartir && (
            <div style={{ margin:'12px 16px', padding:'10px 14px', background:`${C.red}0e`, border:`1px solid ${C.red}44`, borderRadius:9, fontSize:'.72em', color:C.text, lineHeight:1.6 }}>
              {falloCompartir}
              <button
                onClick={() => { setFalloCompartir(null); setImporting(true); }}
                style={{ background:'none', border:'none', color:C.blue, cursor:'pointer', padding:0, marginLeft:8, fontSize:'1em', fontFamily:'inherit', textDecoration:'underline' }}
              >
                abrir el importador
              </button>
            </div>
          )}
          {portfolio.length===0
            ? (
              /* La pantalla vacía decía «añade tus inversiones» y nada más, así
                 que el único camino visible era teclear cinco campos por
                 posición. Importar desde una captura o pegando texto ya estaba
                 hecho, pero escondido tras un icono: aquí es donde hay que
                 ofrecerlo, que es cuando hace falta. */
              <div style={{ padding:'40px 24px', textAlign:'center' }}>
                <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.3em', color:C.goldL, marginBottom:6 }}>
                  Trae tu cartera
                </div>
                <div style={{ fontSize:'.78em', color:C.muted, marginBottom:20, lineHeight:1.6, maxWidth:400, margin:'0 auto 20px' }}>
                  No hace falta teclearla. Haz una captura de tu broker —o copia
                  las posiciones y pégalas— y la IA las extrae sola.
                </div>

                <div style={{ display:'flex', gap:10, justifyContent:'center', flexWrap:'wrap' }}>
                  <button onClick={()=>setImporting(true)}
                    style={{ background:C.gold, border:'none', borderRadius:9, padding:'10px 20px', color:'#07070e', fontWeight:600, cursor:'pointer', fontSize:'.8em', fontFamily:"'Sora',sans-serif" }}>
                    ✨ Importar automáticamente
                  </button>
                  <button onClick={()=>setAdding(true)}
                    style={{ background:'transparent', border:`1px solid ${C.border2}`, borderRadius:9, padding:'10px 20px', color:C.muted, cursor:'pointer', fontSize:'.8em', fontFamily:"'Sora',sans-serif" }}>
                    Añadir una a mano
                  </button>
                </div>

                <div style={{ fontSize:'.68em', color:C.faint, marginTop:18, lineHeight:1.6, maxWidth:420, margin:'18px auto 0' }}>
                  Si usas Trade Republic, hazlo desde su web: su aplicación del móvil
                  no deja capturar pantalla.
                </div>
              </div>
            )
            : <>
                <div style={{ display:'grid', gridTemplateColumns:'80px 1fr 60px 75px 75px 90px 60px 30px 36px', padding:'7px 16px', fontSize:'.6em', color:C.muted, letterSpacing:'1px', textTransform:'uppercase', borderBottom:`1px solid ${C.border}` }}>
                  {['Ticker','Nombre','Acc.','P.Compra','P.Actual','P&L','','🔔',''].map((h,i)=><span key={i}>{h}</span>)}
                </div>
                {portfolio.map(p=>{
                  const pnlVal=(p.currentPrice-p.avgPrice)*p.shares;
                  const pnlP=(p.currentPrice-p.avgPrice)/p.avgPrice*100;
                  const tickerAlert = priceAlerts.find(a => a.ticker === p.ticker && a.active);
                  const isEditingAlert = alertInput?.ticker === p.ticker;
                  return (
                    <div key={p.id}>
                      <div className="pos-row" style={{ display:'grid', gridTemplateColumns:'80px 1fr 60px 75px 75px 90px 60px 30px 36px', padding:'11px 16px', borderBottom: isEditingAlert ? 'none' : `1px solid ${C.border}22`, fontSize:'.82em', alignItems:'center', transition:'background .15s' }}>
                        <span style={{ color:C.gold, fontWeight:600, fontFamily:"'DM Mono',monospace" }}>{p.ticker}</span>
                        <span style={{ color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', paddingRight:8 }}>{p.name}</span>
                        <span style={{ color:C.muted, fontFamily:"'DM Mono',monospace" }}>{p.shares}</span>
                        <span style={{ color:C.muted, fontFamily:"'DM Mono',monospace" }}>{p.avgPrice}€</span>
                        <span style={{ color:C.text,  fontFamily:"'DM Mono',monospace" }}>{p.currentPrice}€</span>
                        <div>
                          <div style={{ color:pnlVal>=0?C.green:C.red, fontFamily:"'DM Mono',monospace", fontSize:'.9em' }}>{pnlVal>=0?'+':''}{pnlVal.toFixed(0)}€</div>
                          <div style={{ color:pnlVal>=0?C.green:C.red, fontSize:'.72em', opacity:.75 }}>{pnlP>=0?'+':''}{pnlP.toFixed(1)}%</div>
                        </div>
                        <button onClick={()=>setSellPos(p)}
                          style={{ background:'rgba(224,82,82,.1)', border:`1px solid ${C.red}44`, color:C.red, borderRadius:6, padding:'3px 8px', cursor:'pointer', fontSize:'.68em', fontFamily:"'Sora',sans-serif", transition:'all .15s' }}
                          onMouseEnter={e=>{ (e.currentTarget.style.background=`rgba(224,82,82,.22)`); }}
                          onMouseLeave={e=>{ (e.currentTarget.style.background=`rgba(224,82,82,.1)`); }}>
                          Vender
                        </button>
                        {/* Feature 3: Bell alert button */}
                        <button
                          title={tickerAlert ? `Alerta activa${tickerAlert.above ? ` >${tickerAlert.above}€` : ''}${tickerAlert.below ? ` <${tickerAlert.below}€` : ''}` : 'Configurar alerta de precio'}
                          onClick={() => setAlertInput(isEditingAlert ? null : { ticker: p.ticker, above: tickerAlert?.above?.toString() || '', below: tickerAlert?.below?.toString() || '' })}
                          style={{ background:'transparent', border:'none', cursor:'pointer', fontSize:'.82em', borderRadius:6, padding:3, position:'relative', transition:'opacity .15s' }}>
                          🔔
                          {tickerAlert && (
                            <div style={{ position:'absolute', top:0, right:0, width:7, height:7, borderRadius:'50%', background:'#c9a84c', border:'1px solid #07070e' }} />
                          )}
                        </button>
                        <button onClick={()=>remove(p.id)} style={{ background:'transparent', border:'none', color:'#252540', cursor:'pointer', fontSize:'.9em', borderRadius:6, padding:4, transition:'color .15s' }} onMouseEnter={e=>(e.target as HTMLElement).style.color=C.red} onMouseLeave={e=>(e.target as HTMLElement).style.color='#252540'}>✕</button>
                      </div>
                      {/* Inline alert config dropdown */}
                      {isEditingAlert && alertInput && (
                        <div style={{ padding:'10px 16px', background:'#0a0a1a', borderBottom:`1px solid ${C.border}22`, display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                          <span style={{ fontSize:'.68em', color:C.muted }}>Alertar si</span>
                          <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                            <span style={{ fontSize:'.66em', color:C.faint }}>sube de</span>
                            <input
                              type="number"
                              value={alertInput.above}
                              onChange={e => setAlertInput({ ...alertInput, above: e.target.value })}
                              placeholder="—"
                              style={{ ...inputBase, width:70, padding:'3px 7px', fontSize:'.74em' }}
                            />
                            <span style={{ fontSize:'.66em', color:C.faint }}>€</span>
                          </div>
                          <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                            <span style={{ fontSize:'.66em', color:C.faint }}>o baja de</span>
                            <input
                              type="number"
                              value={alertInput.below}
                              onChange={e => setAlertInput({ ...alertInput, below: e.target.value })}
                              placeholder="—"
                              style={{ ...inputBase, width:70, padding:'3px 7px', fontSize:'.74em' }}
                            />
                            <span style={{ fontSize:'.66em', color:C.faint }}>€</span>
                          </div>
                          <button
                            onClick={() => {
                              const above = alertInput.above ? parseFloat(alertInput.above) : undefined;
                              const below = alertInput.below ? parseFloat(alertInput.below) : undefined;
                              const next = priceAlerts.filter(a => a.ticker !== p.ticker);
                              if (above || below) next.push({ ticker: p.ticker, above, below, active: true });
                              savePriceAlerts(next);
                              setPriceAlerts(next);
                              setAlertInput(null);
                            }}
                            style={{ background:C.gold, border:'none', borderRadius:7, padding:'4px 12px', color:'#07070e', fontWeight:600, cursor:'pointer', fontSize:'.72em', fontFamily:"'Sora',sans-serif" }}>
                            Guardar
                          </button>
                          {tickerAlert && (
                            <button
                              onClick={() => {
                                const next = priceAlerts.filter(a => a.ticker !== p.ticker);
                                savePriceAlerts(next);
                                setPriceAlerts(next);
                                setAlertInput(null);
                              }}
                              style={{ background:'transparent', border:`1px solid ${C.border2}`, borderRadius:7, padding:'4px 10px', color:C.muted, cursor:'pointer', fontSize:'.72em', fontFamily:"'Sora',sans-serif" }}>
                              Eliminar
                            </button>
                          )}
                          <button onClick={() => setAlertInput(null)} style={{ background:'transparent', border:'none', color:C.faint, cursor:'pointer', fontSize:'.82em', marginLeft:'auto' }}>✕</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>}
        </Card>
        {portfolio.length>0 && (
          <PortfolioSidePanel portfolio={portfolio} totalVal={totalVal} chartData={chartData} />
        )}
      </div>
      {importing && (
        <ImportModal
          imagenInicial={capturaCompartida}
          onClose={() => { setImporting(false); setCapturaCompartida(null); }}
          onImport={async positions => {
            await save([...portfolio, ...positions]);
            setImporting(false);
            setCapturaCompartida(null);
          }}
        />
      )}
      {sellPos && <SellModal pos={sellPos} onClose={()=>setSellPos(null)} />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   RESEARCH TAB
══════════════════════════════════════════════════════════════ */
/**
 * True cuando la pantalla es demasiado estrecha para dos columnas.
 *
 * La app usa estilos en linea, asi que no hay hoja de estilos donde poner una
 * media query: se consulta matchMedia y se re-renderiza al cambiar.
 */
function useNarrowViewport(maxWidth = 720): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= maxWidth,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [maxWidth]);
  return narrow;
}

function ResearchTab({ portfolio, profile }: { portfolio: Position[]; profile: string }) {
  // En movil las dos columnas no caben: 280px fijos dejaban al panel de la
  // derecha unos 130px y el texto salia a una palabra por linea.
  const narrow = useNarrowViewport();
  const [asset,           setAsset]           = useState('');
  const [running,         setRunning]         = useState(false);
  const [steps,           setSteps]           = useState<{ label:string; status:string; provider?:string }[]>([]);
  const [curStep,         setCurStep]         = useState(-1);
  const [report,          setReport]          = useState<string|null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);

  // ── Modo Debate ────────────────────────────────────────────────
  const [debateAsset,   setDebateAsset]   = useState('');
  const [debateRunning, setDebateRunning] = useState(false);
  const [debateBull,    setDebateBull]    = useState<string|null>(null);
  const [debateBear,    setDebateBear]    = useState<string|null>(null);
  const [debateVeredicto, setDebateVeredicto] = useState<string|null>(null);
  const [activeView,    setActiveView]    = useState<'research'|'debate'|'carta'>('research');

  // ── Carta del Gestor ───────────────────────────────────────────
  const [cartaRunning,  setCartaRunning]  = useState(false);
  const [carta,         setCarta]         = useState<string|null>(null);

  const runBriefing = async () => {
    if (briefingLoading || running) return;
    setBriefingLoading(true);
    setReport(null); setSteps([]); setCurStep(-1); setAsset('Briefing Diario');
    try {
      const result = await nexusMarketBriefing();
      setReport(result);
    } catch(e:any) {
      setReport(`⚠️ Error al obtener el briefing: ${e.message}`);
    } finally { setBriefingLoading(false); }
  };

  const run = async () => {
    if (!asset.trim()||running) return;
    setRunning(true); setReport(null); setSteps([]); setCurStep(-1);
    const results:string[] = [];

    for (let i=0; i<RESEARCH_STEPS.length; i++) {
      const step = RESEARCH_STEPS[i];
      setCurStep(i);
      setSteps(s=>[...s, { label:step.label, status:'running' }]);
      try {
        const res = await nexusResearch(
          step.task as any,
          step.q(asset),
          r => setSteps(s=>s.map((x,j)=>j===i?{...x,provider:r.provider}:x)),
        );
        results.push(`### ${step.label}\n${res}`);
        setSteps(s=>s.map((x,j)=>j===i?{...x,status:'done'}:x));
      } catch {
        setSteps(s=>s.map((x,j)=>j===i?{...x,status:'error'}:x));
      }
    }

    setCurStep(RESEARCH_STEPS.length);
    try {
      const synthesis = await nexusResearch(
        'synthesis',
        `Datos de investigación sobre **${asset}**:\n\n${results.join('\n\n---\n\n')}\n\nRedacta el informe de inversión completo y profesional.`,
      );
      setReport(synthesis);
    } catch(e:any) { setReport(`⚠️ Error en síntesis: ${e.message}`); }
    setRunning(false); setCurStep(-1);
  };

  // ── Modo Debate: Bull IA vs Bear IA ─────────────────────────────
  const runDebate = async () => {
    if (!debateAsset.trim() || debateRunning) return;
    setDebateRunning(true); setDebateBull(null); setDebateBear(null); setDebateVeredicto(null);
    setActiveView('debate');

    const bullPrompt = `Eres el Toro: analista financiero ultraoptimista. Tienes que argumentar CON FUERZA y datos por qué invertir en "${debateAsset}" AHORA es una oportunidad excelente. Cita catalizadores concretos, valoración atractiva, momentum, ventajas competitivas, mercados addressables. 3-4 párrafos de análisis sólido. Sé persuasivo.`;
    const bearPrompt = `Eres el Oso: analista financiero escéptico. Tienes que argumentar CON DATOS por qué "${debateAsset}" es una mala inversión o al menos tiene riesgos serios que el mercado ignora. Cita valoración excesiva, riesgos estructurales, competencia, deuda, ciclo, catalizadores negativos. 3-4 párrafos. Sé riguroso.`;

    try {
      // El Toro va a Grok y el Oso a Claude: con dos modelos distintos el debate
      // deja de ser Claude discutiendo consigo mismo. Sin clave de Grok, el
      // respaldo devuelve el Toro a Claude y la funcion sigue igual que antes.
      const [bull, bear] = await Promise.all([
        callProvider(
          { provider: 'grok', model: MODELO_DE_AJUSTES,
            fallback: { provider: 'anthropic', model: 'claude-sonnet-5' } },
          [{ role: 'user', content: bullPrompt }],
          'Eres un experto analista financiero alcista. Responde en español.',
          undefined, 1024, false,
        ),
        callAnthropic([{ role: 'user', content: bearPrompt }], 'Eres un experto analista financiero bajista. Responde en español.', 'claude-sonnet-5', undefined, 1024, false),
      ]);
      setDebateBull(bull);
      setDebateBear(bear);

      // Veredicto final
      const verdPrompt = `Has leído dos análisis opuestos sobre "${debateAsset}":\n\n**TORO (alcista):**\n${bull}\n\n**OSO (bajista):**\n${bear}\n\nComo árbitro independiente, da un VEREDICTO FINAL equilibrado: resume los 2 mejores argumentos de cada lado, y concluye con una recomendación práctica para un inversor de perfil "${profile}". Máximo 3 párrafos.`;
      const verd = await callAnthropic([{ role: 'user', content: verdPrompt }], 'Eres AURUM, árbitro financiero imparcial. Responde en español.', 'claude-sonnet-5', undefined, 768, false);
      setDebateVeredicto(verd);
    } catch(e:any) {
      setDebateBull(`⚠️ Error: ${e.message}`);
    }
    setDebateRunning(false);
  };

  // ── Carta del Gestor (estilo Berkshire) ─────────────────────────
  const runCarta = async () => {
    if (cartaRunning) return;
    setCartaRunning(true); setCarta(null);
    setActiveView('carta');

    const totalVal  = portfolio.reduce((a,p) => a + p.shares * p.currentPrice, 0);
    const totalCost = portfolio.reduce((a,p) => a + p.shares * p.avgPrice, 0);
    const pnl       = totalVal - totalCost;
    const pnlPct    = totalCost ? (pnl / totalCost * 100) : 0;
    const posLines  = portfolio.map(p => {
      const val = p.shares * p.currentPrice;
      const pct = totalVal ? (val / totalVal * 100) : 0;
      const pp  = p.avgPrice ? ((p.currentPrice - p.avgPrice) / p.avgPrice * 100) : 0;
      return `- ${p.ticker} (${p.name}): ${pct.toFixed(1)}% cartera, P&L ${pp>=0?'+':''}${pp.toFixed(1)}%`;
    }).join('\n');

    const prompt = `Eres el gestor de AURUM Capital. Escribe la **Carta Mensual al Inversor** de ${new Date().toLocaleDateString('es-ES',{month:'long',year:'numeric'})} estilo carta de Berkshire Hathaway — reflexiva, honesta, con visión a largo plazo. Sin tecnicismos innecesarios. Firma como "El Gestor".

**Datos de la cartera:**
- Perfil inversor: ${profile}
- Valor total: ${totalVal.toLocaleString('es-ES',{maximumFractionDigits:0})}€
- Resultado acumulado: ${pnl>=0?'+':''}${pnl.toLocaleString('es-ES',{maximumFractionDigits:0})}€ (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)
- Posiciones:
${posLines}

Estructura la carta en: (1) Rendimiento del mes en contexto, (2) Reflexión sobre 1-2 posiciones clave, (3) Visión de mercado y qué vigilamos, (4) Un pensamiento final sobre inversión a largo plazo. Tono elegante, personal. 4-5 párrafos. En español.`;

    try {
      const result = await callAnthropic(
        [{ role: 'user', content: prompt }],
        'Eres el gestor de un fondo de inversión boutique. Escribes cartas mensuales a tus inversores con sabiduría, honestidad y visión a largo plazo.',
        'claude-sonnet-5',
        undefined, 1536, false, // carta: sin web search (usa datos del portfolio ya en el prompt)
      );
      setCarta(result);
    } catch(e:any) { setCarta(`⚠️ Error: ${(e as any).message}`); }
    setCartaRunning(false);
  };

  return (
    <div style={{ display:'flex', flexDirection: narrow?'column':'row', height:'100%', overflow: narrow?'auto':'hidden' }}>
      <div style={{ width: narrow?'100%':280, flexShrink:0, borderRight: narrow?'none':`1px solid ${C.border}`, borderBottom: narrow?`1px solid ${C.border}`:'none', display:'flex', flexDirection:'column', padding:'20px 16px', gap:16, overflow: narrow?'visible':'auto', background:C.surf }}>
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.1em', fontWeight:600, color:C.goldL, marginBottom:3 }}>Research Profundo</div>
          <div style={{ fontSize:'.7em', color:C.muted, lineHeight:1.5 }}>Pipeline multi-modelo: GPT-4o Search para datos en vivo → DeepSeek para riesgos → Claude para síntesis</div>
        </div>
        <div>
          <div style={{ fontSize:'.62em', letterSpacing:'2px', color:C.muted, textTransform:'uppercase', marginBottom:7 }}>Activo a investigar</div>
          <input value={asset} onChange={e=>setAsset(e.target.value)} onKeyDown={e=>e.key==='Enter'&&run()}
            placeholder="Ej: Apple, VWCE, Bitcoin, Inditex…" style={{ ...inputBase, marginBottom:8 }} />
          <button onClick={()=>{setActiveView('research');run();}} disabled={running||!asset.trim()}
            style={{ width:'100%', padding:'9px', background:asset.trim()&&!running?C.gold:'#1a1a28', border:'none', borderRadius:9, color:asset.trim()&&!running?'#07070e':C.muted, fontWeight:600, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif", transition:'all .18s', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
            {running?<><Spinner/>Investigando…</>:'🔬 Iniciar Research'}
          </button>
          <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:14 }}>
            <div style={{ fontSize:'.62em', letterSpacing:'2px', color:C.muted, textTransform:'uppercase', marginBottom:7 }}>Mercados hoy</div>
            <button onClick={()=>{runBriefing();setActiveView('research');}} disabled={briefingLoading || running}
              style={{ width:'100%', padding:'9px', background:briefingLoading?'#1a1a28':`${C.blue}18`, border:`1px solid ${briefingLoading?C.border:C.blue+'44'}`, borderRadius:9, color:briefingLoading?C.muted:C.blue, fontWeight:600, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif", transition:'all .18s', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
              {briefingLoading?<><Spinner/>Cargando…</>:'📊 Briefing diario'}
            </button>
          </div>
        </div>

        {/* ── Modo Debate ──────────────────────────────────────── */}
        <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:14 }}>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1em', fontWeight:600, color:'#e8734a', marginBottom:2 }}>⚔️ Modo Debate</div>
          <div style={{ fontSize:'.68em', color:C.muted, lineHeight:1.45, marginBottom:9 }}>Toro IA vs Oso IA discuten un activo. Claude arbitra el veredicto.</div>
          <input value={debateAsset} onChange={e=>setDebateAsset(e.target.value)} onKeyDown={e=>e.key==='Enter'&&runDebate()}
            placeholder="Activo a debatir…" style={{ ...inputBase, marginBottom:8 }} />
          <button onClick={runDebate} disabled={debateRunning||!debateAsset.trim()}
            style={{ width:'100%', padding:'9px', background:debateAsset.trim()&&!debateRunning?'#e8734a':'#1a1a28', border:'none', borderRadius:9, color:debateAsset.trim()&&!debateRunning?'#fff':C.muted, fontWeight:600, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif", transition:'all .18s', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
            {debateRunning?<><Spinner/>Debatiendo…</>:'⚔️ Iniciar Debate'}
          </button>
        </div>

        {/* ── Carta del Gestor ─────────────────────────────────── */}
        <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:14 }}>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1em', fontWeight:600, color:C.purple, marginBottom:2 }}>📝 Carta del Gestor</div>
          <div style={{ fontSize:'.68em', color:C.muted, lineHeight:1.45, marginBottom:9 }}>Carta mensual estilo Berkshire: reflexión sobre tu cartera, visión de mercado y sabiduría de largo plazo.</div>
          <button onClick={runCarta} disabled={cartaRunning||portfolio.length===0}
            style={{ width:'100%', padding:'9px', background:portfolio.length&&!cartaRunning?`${C.purple}22`:'#1a1a28', border:`1px solid ${portfolio.length&&!cartaRunning?C.purple+'55':C.border}`, borderRadius:9, color:portfolio.length&&!cartaRunning?C.purple:C.muted, fontWeight:600, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif", transition:'all .18s', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
            {cartaRunning?<><Spinner/>Redactando…</>:portfolio.length===0?'📝 Añade posiciones primero':'📝 Generar Carta'}
          </button>
        </div>
        {steps.length>0 && (
          <div>
            <div style={{ fontSize:'.62em', letterSpacing:'2px', color:C.muted, textTransform:'uppercase', marginBottom:8 }}>Pipeline</div>
            {RESEARCH_STEPS.map((s,i)=>{
              const st=steps[i]?.status, active=curStep===i;
              const prov=steps[i]?.provider;
              const pm = prov ? PROVIDER_META[prov as keyof typeof PROVIDER_META] : null;
              return (
                <div key={i} className="step-in" style={{ display:'flex', alignItems:'center', gap:9, padding:'7px 10px', borderRadius:8, marginBottom:5, background:active?`${C.gold}10`:st==='done'?`${C.green}0c`:'transparent', border:`1px solid ${active?C.gold+'33':st==='done'?C.green+'22':C.border}`, opacity:i>curStep&&!st?.includes('done')?0.4:1, transition:'all .2s', animationDelay:`${i*.06}s` }}>
                  <span style={{ fontSize:'.95em', flexShrink:0 }}>{st==='done'?'✅':st==='error'?'❌':active?<Spinner/>:'○'}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:'.71em', color:active?C.gold:st==='done'?C.green:C.muted, lineHeight:1.3 }}>{s.label}</div>
                    {pm && <div style={{ fontSize:'.62em', color:pm.color, marginTop:2 }}>{pm.short}</div>}
                  </div>
                </div>
              );
            })}
            {curStep>=RESEARCH_STEPS.length&&running && (
              <div style={{ display:'flex', alignItems:'center', gap:9, padding:'7px 10px', borderRadius:8, background:`${C.gold}10`, border:`1px solid ${C.gold}33` }}>
                <Spinner />
                <div>
                  <div style={{ fontSize:'.71em', color:C.gold }}>Sintetizando informe…</div>
                  <div style={{ fontSize:'.62em', color:PROVIDER_META.anthropic.color }}>Claude</div>
                </div>
              </div>
            )}
          </div>
        )}
        {/* Nexus legend */}
        <div style={{ marginTop:'auto', padding:'10px', background:'#07070e', borderRadius:8, border:`1px solid ${C.border}` }}>
          <div style={{ fontSize:'.6em', color:C.muted, marginBottom:6, letterSpacing:'1px', textTransform:'uppercase' }}>Nexus Routing</div>
          {Object.entries(PROVIDER_META).map(([k,v])=>(
            <div key={k} style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4, fontSize:'.65em' }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background:v.color, flexShrink:0 }}/>
              <span style={{ color:v.color }}>{v.label}</span>
              <span style={{ color:C.faint }}>· {k==='anthropic'?'Chat general, fiscal':k==='openai'?'Macro, research web':'Riesgos, razonamiento'}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex:1, overflow: narrow?'visible':'auto', padding:'24px 28px', minHeight: narrow?300:undefined }}>

        {/* ── Vista: Research ───────────────────────────────── */}
        {activeView==='research' && <>
          {!report&&!running && (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:14, color:C.muted, textAlign:'center' }}>
              <div style={{ fontSize:'2.8em', opacity:.2 }}>🔬</div>
              <div style={{ fontSize:'.92em' }}>Introduce un activo para comenzar</div>
              <div style={{ fontSize:'.74em', opacity:.6, maxWidth:320, lineHeight:1.6 }}>AURUM Nexus lanza un pipeline de 5 búsquedas con GPT-4o, analiza riesgos con DeepSeek R1 y sintetiza el informe final con Claude.</div>
            </div>
          )}
          {running&&!report && (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:14, color:C.muted }}>
              <Dots /><div style={{ fontSize:'.88em' }}>Investigando <strong style={{ color:C.gold }}>{asset}</strong>…</div>
            </div>
          )}
          {report && (
            <div>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:22, paddingBottom:18, borderBottom:`1px solid ${C.border}` }}>
                <div style={{ width:44, height:44, borderRadius:12, background:`linear-gradient(135deg,${C.goldD},${C.goldL})`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, fontWeight:800, color:'#07070e', flexShrink:0, fontFamily:"'Cormorant Garamond',serif" }}>A</div>
                <div>
                  <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.22em', fontWeight:600, color:C.goldL }}>Informe de Inversión — {asset}</div>
                  <div style={{ fontSize:'.68em', color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:2, display:'flex', gap:8, alignItems:'center' }}>
                    {new Date().toLocaleDateString('es-ES',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}
                    <ProviderBadge provider="anthropic" model="claude-sonnet-5" />
                  </div>
                </div>
              </div>
              <div style={{ fontSize:'.88em', lineHeight:1.78, color:C.text }}><Md text={report} /></div>
            </div>
          )}
        </>}

        {/* ── Vista: Debate ─────────────────────────────────── */}
        {activeView==='debate' && (
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:22, paddingBottom:18, borderBottom:`1px solid ${C.border}` }}>
              <div style={{ width:44, height:44, borderRadius:12, background:'linear-gradient(135deg,#e8734a,#f0a070)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, flexShrink:0 }}>⚔️</div>
              <div>
                <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.22em', fontWeight:600, color:'#e8734a' }}>Debate Toro vs Oso — {debateAsset || '…'}</div>
                <div style={{ fontSize:'.68em', color:C.muted, marginTop:2 }}>Dos IAs con tesis opuestas · Claude arbitra el veredicto final</div>
              </div>
            </div>

            {debateRunning && !debateBull && (
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'60%', gap:14, color:C.muted }}>
                <Dots /><div style={{ fontSize:'.88em' }}>Preparando argumentos…</div>
              </div>
            )}

            {(debateBull || debateBear) && (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:20 }}>
                {/* Bull */}
                <div style={{ background:`${C.green}0c`, border:`1px solid ${C.green}33`, borderRadius:12, padding:'16px 18px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
                    <span style={{ fontSize:'1.3em' }}>🐂</span>
                    <span style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.05em', fontWeight:600, color:C.green }}>Toro — Caso Alcista</span>
                  </div>
                  {debateBull
                    ? <div style={{ fontSize:'.82em', lineHeight:1.75, color:C.text }}><Md text={debateBull} /></div>
                    : <div style={{ display:'flex', gap:8, alignItems:'center', color:C.muted }}><Spinner/> Construyendo tesis…</div>
                  }
                </div>
                {/* Bear */}
                <div style={{ background:`${C.red}0c`, border:`1px solid ${C.red}33`, borderRadius:12, padding:'16px 18px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
                    <span style={{ fontSize:'1.3em' }}>🐻</span>
                    <span style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.05em', fontWeight:600, color:C.red }}>Oso — Caso Bajista</span>
                  </div>
                  {debateBear
                    ? <div style={{ fontSize:'.82em', lineHeight:1.75, color:C.text }}><Md text={debateBear} /></div>
                    : <div style={{ display:'flex', gap:8, alignItems:'center', color:C.muted }}><Spinner/> Construyendo tesis…</div>
                  }
                </div>
              </div>
            )}

            {/* Veredicto */}
            {(debateVeredicto || (debateRunning && debateBull && debateBear && !debateVeredicto)) && (
              <div style={{ background:`${C.gold}0a`, border:`1px solid ${C.gold}44`, borderRadius:12, padding:'16px 18px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
                  <span style={{ fontSize:'1.3em' }}>⚖️</span>
                  <span style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.1em', fontWeight:600, color:C.gold }}>Veredicto AURUM</span>
                  {!debateVeredicto && <Spinner />}
                </div>
                {debateVeredicto && <div style={{ fontSize:'.84em', lineHeight:1.8, color:C.text }}><Md text={debateVeredicto} /></div>}
              </div>
            )}
          </div>
        )}

        {/* ── Vista: Carta del Gestor ───────────────────────── */}
        {activeView==='carta' && (
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:22, paddingBottom:18, borderBottom:`1px solid ${C.border}` }}>
              <div style={{ width:44, height:44, borderRadius:12, background:`linear-gradient(135deg,${C.purple}88,${C.purple})`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, flexShrink:0 }}>📝</div>
              <div>
                <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.22em', fontWeight:600, color:C.purple }}>Carta del Gestor — {new Date().toLocaleDateString('es-ES',{month:'long',year:'numeric'})}</div>
                <div style={{ fontSize:'.68em', color:C.muted, marginTop:2 }}>Análisis mensual · estilo Berkshire Hathaway · redactada por AURUM</div>
              </div>
            </div>

            {cartaRunning && !carta && (
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'60%', gap:14, color:C.muted }}>
                <Dots /><div style={{ fontSize:'.88em' }}>Redactando la carta…</div>
              </div>
            )}

            {carta && (
              <div style={{ background:`${C.purple}06`, border:`1px solid ${C.purple}22`, borderRadius:12, padding:'24px 28px', fontFamily:"'Cormorant Garamond',serif" }}>
                <div style={{ fontSize:'.98em', lineHeight:2, color:C.text, fontStyle:'italic' }}><Md text={carta} /></div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   SIMULATOR TAB — Monte Carlo + interés compuesto
══════════════════════════════════════════════════════════════ */

// Genera retorno anual aleatorio con distribución normal (Box-Muller)
function randNormal(mean: number, std: number): number {
  const u = 1 - Math.random(), v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + std * z;
}

// Volatilidades históricas por perfil
const PROFILE_PARAMS: Record<string, { mean: number; std: number; label: string }> = {
  conservador: { mean: 0.043, std: 0.055, label: 'Conservador' },
  moderado:    { mean: 0.073, std: 0.115, label: 'Moderado'    },
  agresivo:    { mean: 0.099, std: 0.195, label: 'Agresivo'    },
  custom:      { mean: 0.07,  std: 0.12,  label: 'Personalizado'},
};

function runMonteCarlo(initial: number, monthly: number, years: number, mean: number, std: number, sims = 1000) {
  // Devuelve percentiles p10, p50, p90 por año + capital aportado
  const perYear: number[][] = Array.from({ length: years + 1 }, () => []);
  for (let s = 0; s < sims; s++) {
    let bal = initial;
    perYear[0].push(bal);
    for (let y = 1; y <= years; y++) {
      const r = randNormal(mean, std);
      bal = bal * (1 + r) + monthly * 12;
      if (bal < 0) bal = 0;
      perYear[y].push(bal);
    }
  }
  return perYear.map((vals, y) => {
    const sorted = [...vals].sort((a, b) => a - b);
    const p = (q: number) => Math.round(sorted[Math.floor(q * (sims - 1))]);
    return {
      año: y,
      'Optimista (p90)':  p(0.90),
      'Base (p50)':       p(0.50),
      'Pesimista (p10)':  p(0.10),
      'Capital aportado': Math.round(initial + monthly * 12 * y),
    };
  });
}

function SimulatorTab() {
  const [initial,  setInitial]  = useState(10000);
  const [monthly,  setMonthly]  = useState(300);
  const [years,    setYears]    = useState(20);
  const [perfil,   setPerfil]   = useState<'conservador'|'moderado'|'agresivo'|'custom'>('moderado');
  const [customMean, setCustomMean] = useState(7.0);   // %
  const [customStd,  setCustomStd]  = useState(12.0);  // %
  const [mcData,   setMcData]   = useState<ReturnType<typeof runMonteCarlo>>([]);
  const [running,  setRunning]  = useState(false);

  // Recalcula al cambiar parámetros
  useEffect(() => {
    setRunning(true);
    const timer = setTimeout(() => {
      const p = perfil === 'custom'
        ? { mean: customMean / 100, std: customStd / 100 }
        : PROFILE_PARAMS[perfil];
      setMcData(runMonteCarlo(initial, monthly, years, p.mean, p.std, 1200));
      setRunning(false);
    }, 80);
    return () => clearTimeout(timer);
  }, [initial, monthly, years, perfil, customMean, customStd]);

  const last   = mcData.at(-1);
  const aportado = last?.['Capital aportado'] ?? 0;
  const base     = last?.['Base (p50)']       ?? 0;
  const opt      = last?.['Optimista (p90)']  ?? 0;
  const pes      = last?.['Pesimista (p10)']  ?? 0;
  const p = PROFILE_PARAMS[perfil];

  const fmt = (v: number) => v >= 1_000_000
    ? `${(v/1_000_000).toFixed(2)}M€`
    : v >= 1000 ? `${(v/1000).toFixed(0)}k€` : `${v}€`;

  const sliders = [
    { label:'Capital inicial',    val:initial, set:setInitial, min:0,     max:200000, step:500,  fmt:(v:number)=>`${v.toLocaleString('es-ES')}€` },
    { label:'Aportación mensual', val:monthly, set:setMonthly, min:0,     max:3000,   step:50,   fmt:(v:number)=>`${v}€/mes` },
    { label:'Horizonte temporal', val:years,   set:setYears,   min:1,     max:40,     step:1,    fmt:(v:number)=>`${v} años` },
  ];

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>
      {/* Panel izquierdo */}
      <div style={{ width:270, flexShrink:0, borderRight:`1px solid ${C.border}`, padding:'18px 16px', display:'flex', flexDirection:'column', gap:16, overflow:'auto', background:C.surf }}>
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.1em', fontWeight:600, color:C.goldL, marginBottom:2 }}>Monte Carlo</div>
          <div style={{ fontSize:'.68em', color:C.muted, lineHeight:1.5 }}>1.200 simulaciones · distribución histórica real</div>
        </div>

        {/* Perfil de retorno */}
        <div>
          <div style={{ fontSize:'.62em', color:C.muted, marginBottom:6, letterSpacing:'.5px' }}>PERFIL DE RENTABILIDAD</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
            {(['conservador','moderado','agresivo','custom'] as const).map(k => {
              const pp = PROFILE_PARAMS[k];
              const active = perfil === k;
              return (
                <button key={k} onClick={() => setPerfil(k)} style={{
                  padding:'7px 6px', borderRadius:7, cursor:'pointer', textAlign:'center',
                  background: active ? `${C.gold}22` : C.surf2,
                  border:`1px solid ${active ? C.gold+'66' : C.border}`,
                  color: active ? C.gold : C.muted, fontSize:'.65em',
                }}>
                  {pp.label}<br/>
                  <span style={{ fontSize:'.85em', color:C.faint }}>
                    {k === 'custom' ? '✏️' : `μ${(pp.mean*100).toFixed(1)}% σ${(pp.std*100).toFixed(0)}%`}
                  </span>
                </button>
              );
            })}
          </div>
          {perfil === 'custom' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginTop:8 }}>
              <div>
                <div style={{ fontSize:'.6em', color:C.muted, marginBottom:3 }}>Retorno medio %</div>
                <input type="number" value={customMean} onChange={e=>setCustomMean(+e.target.value)} min={-5} max={30} step={0.5}
                  style={{ ...{background:C.surf2,border:`1px solid ${C.border2}`,borderRadius:7,padding:'5px 8px',color:C.text,fontSize:'.8em',width:'100%'} }} />
              </div>
              <div>
                <div style={{ fontSize:'.6em', color:C.muted, marginBottom:3 }}>Volatilidad %</div>
                <input type="number" value={customStd} onChange={e=>setCustomStd(+e.target.value)} min={1} max={60} step={1}
                  style={{ ...{background:C.surf2,border:`1px solid ${C.border2}`,borderRadius:7,padding:'5px 8px',color:C.text,fontSize:'.8em',width:'100%'} }} />
              </div>
            </div>
          )}
        </div>

        {/* Sliders */}
        {sliders.map(s=>(
          <div key={s.label}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
              <span style={{ fontSize:'.7em', color:C.muted }}>{s.label}</span>
              <span style={{ fontSize:'.75em', color:C.gold, fontFamily:"'DM Mono',monospace" }}>{s.fmt(s.val)}</span>
            </div>
            <input type="range" min={s.min} max={s.max} step={s.step} value={s.val} onChange={e=>s.set(+e.target.value)} style={{ width:'100%' }} />
          </div>
        ))}

        {/* Resultados */}
        <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:11, overflow:'hidden' }}>
          {[
            ['🎯 Escenario base (p50)',    fmt(base),           C.goldL],
            ['🚀 Optimista (p90)',         fmt(opt),            C.green],
            ['🛡️ Pesimista (p10)',         fmt(pes),            C.red],
            ['💶 Total aportado',          fmt(aportado),       C.text],
            ['📈 Ganancia base',           `+${fmt(base-aportado)}`, C.green],
            ['×  Multiplicador base',     `×${(base/Math.max(aportado,1)).toFixed(2)}`, C.blue],
          ].map(([l,v,c])=>(
            <div key={l as string} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 12px', borderBottom:`1px solid ${C.border}22` }}>
              <span style={{ fontSize:'.68em', color:C.muted }}>{l}</span>
              <span style={{ fontSize:'.78em', fontWeight:600, color:c as string, fontFamily:"'DM Mono',monospace" }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize:'.6em', color:C.faint, lineHeight:1.5 }}>
          μ={perfil==='custom'?customMean.toFixed(1):(p.mean*100).toFixed(1)}% σ={perfil==='custom'?customStd.toFixed(0):(p.std*100).toFixed(0)}% · Sin impuestos ni inflación.
        </div>
      </div>

      {/* Gráfico */}
      <div style={{ flex:1, padding:'18px 16px', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
          <div style={{ fontSize:'.62em', letterSpacing:'2px', color:C.muted, textTransform:'uppercase' }}>
            Proyección probabilística · {years} años {running ? '⏳' : ''}
          </div>
          <div style={{ display:'flex', gap:12, fontSize:'.62em' }}>
            <span style={{ color:C.green }}>■ p90 optimista</span>
            <span style={{ color:C.gold  }}>■ p50 base</span>
            <span style={{ color:C.red   }}>■ p10 pesimista</span>
            <span style={{ color:C.blue  }}>■ aportado</span>
          </div>
        </div>
        <div style={{ flex:1, minHeight:0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={mcData} margin={{ top:10, right:20, left:10, bottom:0 }}>
              <defs>
                <linearGradient id="gOpt"  x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.green} stopOpacity={.18}/><stop offset="95%" stopColor={C.green} stopOpacity={.01}/></linearGradient>
                <linearGradient id="gBase" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.gold}  stopOpacity={.35}/><stop offset="95%" stopColor={C.gold}  stopOpacity={.02}/></linearGradient>
                <linearGradient id="gPes"  x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.red}   stopOpacity={.18}/><stop offset="95%" stopColor={C.red}   stopOpacity={.01}/></linearGradient>
                <linearGradient id="gBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.blue}  stopOpacity={.22}/><stop offset="95%" stopColor={C.blue}  stopOpacity={.01}/></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161626"/>
              <XAxis dataKey="año" stroke={C.muted} tick={{ fontSize:10, fill:C.muted }} tickFormatter={(v:number)=>`A${v}`}/>
              <YAxis stroke={C.muted} tick={{ fontSize:10, fill:C.muted }} tickFormatter={(v:number)=>fmt(v)} width={58}/>
              <Tooltip
                contentStyle={{ background:C.surf3, border:`1px solid ${C.border}`, borderRadius:9, fontSize:'.75em' }}
                formatter={(v:unknown) => [`${fmt(v as number)}`]}
                labelFormatter={(v:unknown) => `Año ${v}`}
              />
              <Area type="monotone" dataKey="Capital aportado" stroke={C.blue}  strokeWidth={1.5} fill="url(#gBlue)" strokeDasharray="4 2"/>
              <Area type="monotone" dataKey="Pesimista (p10)"  stroke={C.red}   strokeWidth={1}   fill="url(#gPes)"/>
              <Area type="monotone" dataKey="Base (p50)"       stroke={C.gold}  strokeWidth={2.5} fill="url(#gBase)"/>
              <Area type="monotone" dataKey="Optimista (p90)"  stroke={C.green} strokeWidth={1}   fill="url(#gOpt)"/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   INVEST TAB
══════════════════════════════════════════════════════════════ */
type InvestPhase = 'idle' | 'loading' | 'proposal' | 'executing' | 'done';

function EstimateBar({ label, emoji, pct, capital, highlight }:{ label:string; emoji:string; pct:number; capital:number; highlight?:boolean }) {
  const final = Math.round(capital * (1 + pct / 100));
  const color  = pct >= 0 ? C.green : C.red;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', background:highlight?`${C.gold}0c`:'transparent', borderRadius:9, border:`1px solid ${highlight?C.gold+'33':C.border}` }}>
      <span style={{ fontSize:'1.1em', flexShrink:0 }}>{emoji}</span>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:'.72em', color:C.muted, marginBottom:3 }}>{label}</div>
        <div style={{ height:5, borderRadius:3, background:C.border, overflow:'hidden' }}>
          <div style={{ height:'100%', width:`${Math.min(Math.abs(pct), 100)}%`, background:color, borderRadius:3, transition:'width .6s ease' }}/>
        </div>
      </div>
      <div style={{ textAlign:'right', flexShrink:0 }}>
        <div style={{ fontSize:'.88em', fontWeight:600, color, fontFamily:"'DM Mono',monospace" }}>{pct >= 0 ? '+' : ''}{pct}%</div>
        <div style={{ fontSize:'.7em', color:C.muted, fontFamily:"'DM Mono',monospace" }}>{final.toLocaleString('es-ES')}€</div>
      </div>
    </div>
  );
}

function TradeRow({ trade }:{ trade: import('./nexus/advisor').TradeItem }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'64px 1fr auto', gap:10, padding:'12px 16px', borderBottom:`1px solid ${C.border}22`, alignItems:'center' }}>
      <div>
        <div style={{ fontSize:'.82em', fontWeight:700, color:C.gold, fontFamily:"'DM Mono',monospace" }}>{trade.ticker}</div>
        <div style={{ fontSize:'.58em', color:C.faint, fontFamily:"'DM Mono',monospace", marginTop:1 }}>{trade.isin}</div>
      </div>
      <div>
        <div style={{ fontSize:'.8em', color:C.text }}>{trade.name}</div>
        <div style={{ fontSize:'.68em', color:C.muted, marginTop:2 }}>◆ {trade.reason}</div>
      </div>
      <div style={{ fontSize:'1em', fontWeight:700, color:C.goldL, fontFamily:"'DM Mono',monospace", textAlign:'right', flexShrink:0 }}>
        {trade.amount.toLocaleString('es-ES')}€
      </div>
    </div>
  );
}

/* ── Feature 2: Rebalance Card ────────────────────────────────── */
function RebalanceCard({ portfolio, profile, onNavigate }: {
  portfolio: Position[];
  profile: string;
  onNavigate: (tab: string) => void;
}) {
  const drift = detectDrift(portfolio, profile);
  if (!drift.needsRebal) {
    return (
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 14px', background:`${C.green}0a`, border:`1px solid ${C.green}33`, borderRadius:9, fontSize:'.74em', color:C.green }}>
        <span>✓</span>
        <span>Cartera alineada con el perfil</span>
      </div>
    );
  }
  const bars: { label:string; current:number; target:number; color:string }[] = [
    { label:'RV',  current:drift.current.rv,  target:drift.target.rv,  color:C.gold   },
    { label:'RF',  current:drift.current.rf,  target:drift.target.rf,  color:C.blue   },
    { label:'Alt', current:drift.current.alt, target:drift.target.alt, color:C.purple },
  ];
  return (
    <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:12, padding:'14px 17px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
        <span style={{ fontSize:'.82em', fontWeight:600, color:C.goldL }}>⚖️ Rebalanceo necesario</span>
        <span style={{ fontSize:'.65em', padding:'2px 8px', borderRadius:20, background:`${C.red}18`, border:`1px solid ${C.red}44`, color:C.red, fontFamily:"'DM Mono',monospace" }}>
          desviación {drift.driftPct}%
        </span>
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:12 }}>
        {bars.map(b => (
          <div key={b.label} style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:'.68em', color:C.muted, minWidth:22 }}>{b.label}</span>
            <div style={{ flex:1, position:'relative', height:8, background:C.border, borderRadius:4, overflow:'hidden' }}>
              {/* Target marker */}
              <div style={{ position:'absolute', top:0, bottom:0, left:`${b.target}%`, width:2, background:`${b.color}66`, borderRadius:1 }} />
              {/* Current fill */}
              <div style={{ height:'100%', width:`${b.current}%`, background:b.color, borderRadius:4, transition:'width .5s ease', opacity:.85 }} />
            </div>
            <span style={{ fontSize:'.68em', fontFamily:"'DM Mono',monospace", color:b.color, minWidth:60, textAlign:'right' }}>
              {b.current}% → {b.target}%
            </span>
          </div>
        ))}
      </div>
      <button
        onClick={() => {
          // Pre-rellena el chat con contexto exacto de la desviación
          const msg = `Necesito rebalancear mi cartera. Actualmente tengo RV:${drift.current.rv}% · RF:${drift.current.rf}% · Alt:${drift.current.alt}%, pero mi perfil requiere RV:${drift.target.rv}% · RF:${drift.target.rf}% · Alt:${drift.target.alt}%. ¿Qué ETFs debo comprar o vender para corregirlo? Dime importes concretos.`;
          sessionStorage.setItem('aurum-chat-prefill', msg);
          onNavigate('chat');
        }}
        style={{ width:'100%', padding:'8px', background:`${C.gold}18`, border:`1px solid ${C.gold}44`, borderRadius:9, color:C.goldL, cursor:'pointer', fontSize:'.78em', fontFamily:"'Sora',sans-serif", fontWeight:600, transition:'all .16s' }}
        onMouseEnter={e=>{ e.currentTarget.style.background=`${C.gold}30`; }}
        onMouseLeave={e=>{ e.currentTarget.style.background=`${C.gold}18`; }}>
        💬 Generar plan de rebalanceo con AURUM
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   WATCHLIST
══════════════════════════════════════════════════════════════ */
const WATCHLIST_KEY = 'aurum-watchlist';

function WatchlistCard() {
  const [tickers, setTickers] = useState<string[]>(() => {
    return store.get<string[]>(WATCHLIST_KEY, []);
  });
  const [prices,  setPrices]  = useState<Record<string, { price:number; changePct:number }>>({});
  const [input,   setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const [open,    setOpen]    = useState(true);

  const fetchPrices = async () => {
    if (!tickers.length) return;
    setLoading(true);
    try {
      const result = await nexusPrices(tickers);
      const map: Record<string, { price:number; changePct:number }> = {};
      result.forEach(r => { if (r.ticker) map[r.ticker.toUpperCase()] = { price: r.price, changePct: (r as any).changePct ?? 0 }; });
      setPrices(map);
    } catch { /* silencioso */ } finally { setLoading(false); }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchPrices(); const t = setInterval(fetchPrices, 120_000); return () => clearInterval(t); }, [tickers.join(',')]);

  const add = () => {
    const t = input.trim().toUpperCase();
    if (!t || tickers.includes(t)) { setInput(''); return; }
    const next = [...tickers, t];
    setTickers(next);
    store.set(WATCHLIST_KEY, next);
    setInput('');
  };
  const rem = (t: string) => {
    const next = tickers.filter(x => x !== t);
    setTickers(next);
    setPrices(prev => { const n = { ...prev }; delete n[t]; return n; });
    store.set(WATCHLIST_KEY, next);
  };

  return (
    <Card>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px', borderBottom: open && tickers.length ? `1px solid ${C.border}` : 'none', cursor:'pointer' }} onClick={()=>setOpen(v=>!v)}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:'.65em', letterSpacing:'1.5px', color:C.muted, textTransform:'uppercase' }}>Watchlist</span>
          {tickers.length > 0 && <span style={{ fontSize:'.6em', color:C.faint, fontFamily:"'DM Mono',monospace" }}>{tickers.length}</span>}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }} onClick={e=>e.stopPropagation()}>
          {loading && <Spinner />}
          {tickers.length > 0 && !loading && (
            <button onClick={fetchPrices} title="Actualizar precios"
              style={{ background:'transparent', border:`1px solid ${C.border2}`, color:C.muted, borderRadius:6, padding:'3px 8px', cursor:'pointer', fontSize:'.68em', fontFamily:"'Sora',sans-serif" }}>
              ↻
            </button>
          )}
          <span style={{ color:C.faint, fontSize:'.7em' }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {open && (
        <div style={{ padding:'10px 14px' }}>
          {/* Ticker rows */}
          {tickers.length > 0 && (
            <div style={{ display:'flex', flexDirection:'column', gap:5, marginBottom:10 }}>
              {tickers.map(t => {
                const q = prices[t];
                const up = q && q.changePct >= 0;
                return (
                  <div key={t} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 10px', background:'#0a0a18', borderRadius:8, border:`1px solid ${C.border}` }}>
                    <span style={{ color:C.gold, fontWeight:600, fontFamily:"'DM Mono',monospace", fontSize:'.82em', minWidth:56 }}>{t}</span>
                    {q ? (
                      <>
                        <span style={{ color:C.text, fontFamily:"'DM Mono',monospace", fontSize:'.82em' }}>
                          {q.price >= 1000
                            ? q.price.toLocaleString('es-ES', { maximumFractionDigits:0 })
                            : q.price.toLocaleString('es-ES', { minimumFractionDigits:2, maximumFractionDigits:2 })}€
                        </span>
                        <span style={{ color:up?C.green:C.red, fontFamily:"'DM Mono',monospace", fontSize:'.75em', marginLeft:'auto' }}>
                          {up ? '▲' : '▼'}{Math.abs(q.changePct).toFixed(2)}%
                        </span>
                      </>
                    ) : (
                      <span style={{ color:C.faint, fontSize:'.75em', marginLeft:'auto' }}>—</span>
                    )}
                    <button onClick={()=>rem(t)} title="Quitar de watchlist"
                      style={{ background:'transparent', border:'none', color:C.faint, cursor:'pointer', fontSize:'.8em', padding:'2px 4px', borderRadius:4, transition:'color .15s', marginLeft: q ? 0 : 'auto' }}
                      onMouseEnter={e=>(e.currentTarget.style.color=C.red)} onMouseLeave={e=>(e.currentTarget.style.color=C.faint)}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Add input */}
          <div style={{ display:'flex', gap:8 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
              placeholder="Añadir ticker (VWCE, AAPL, BTC-EUR…)"
              style={{ ...inputBase, fontSize:'.78em' }}
            />
            <button onClick={add}
              style={{ background: input.trim() ? C.gold : C.faint, border:'none', borderRadius:8, padding:'6px 14px', color:'#07070e', fontWeight:600, cursor: input.trim() ? 'pointer' : 'default', fontSize:'.78em', fontFamily:"'Sora',sans-serif", flexShrink:0, transition:'background .15s' }}>
              +
            </button>
          </div>
          {tickers.length === 0 && (
            <div style={{ fontSize:'.68em', color:C.faint, marginTop:8, lineHeight:1.5 }}>
              Sigue tickers sin tenerlos en cartera. Precio actualizado cada 2 min.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function InvestTab({ profile, portfolio, setPortfolio, userProfile, onNavigate }:{
  profile: string;
  portfolio: Position[];
  setPortfolio: (p: Position[]) => void;
  userProfile: UserProfile;
  onNavigate: (tab: string) => void;
}) {
  const [capital,    setCapital]    = useState('');
  const [phase,      setPhase]      = useState<InvestPhase>('idle');
  const [proposal,   setProposal]   = useState<InvestmentProposal | null>(null);
  const [error,      setError]      = useState('');
  const [tradeLog,   setTradeLog]   = useState<{ ticker:string; status:'pending'|'ok'|'error'; msg?:string }[]>([]);
  const [backendCfg, setBackendCfg] = useState<BackendConfig|null>(null);

  // Cargar config del backend al montar
  useState(() => { getBackendConfig().then(setBackendCfg); });

  const analyze = async () => {
    const amount = parseFloat(capital.replace(',', '.'));
    if (!amount || amount < 10) return;
    setPhase('loading'); setProposal(null); setError('');
    try {
      const result = await nexusInvestmentProposal(amount, portfolio, profile, userProfile);
      setProposal(result);
      setPhase('proposal');
    } catch(e:any) {
      setError(e.message || 'Error al generar el plan.');
      setPhase('idle');
    }
  };

  const confirm = async () => {
    if (!proposal) return;
    setPhase('executing');
    // Guardar recomendación para tracking de rendimiento
    saveRecommendation({
      trades:          proposal.trades.map(t => ({ ticker: t.ticker, amount: t.amount, isin: t.isin })),
      profile,
      capital:         proposal.totalAmount,
      rationale:       proposal.rationale,
      executed:        true,
      estimatedReturn: proposal.estimates.base,
    });
    const cfg = await getBackendConfig();

    if (cfg) {
      // ── Ejecución real vía backend Proxmox ──────────────────────
      const log = proposal.trades.map(t => ({ ticker: t.ticker, status: 'pending' as const }));
      setTradeLog(log);
      try {
        const result = await backendCall(cfg, '/invest', 'POST', { trades: proposal.trades });
        const updatedLog = (result.results as any[]).map(r => ({
          ticker: r.ticker,
          status: r.status === 'executed' ? 'ok' as const : 'error' as const,
          msg:    r.status === 'error' ? r.error : `Orden ${r.orderId || 'procesada'}`,
        }));
        setTradeLog(updatedLog);
      } catch(e:any) {
        setTradeLog(log.map(l => ({ ...l, status: 'error' as const, msg: e.message })));
      }
    } else {
      // ── Sin backend: solo la guía manual ─────────────────────────
      //
      // Antes esto apuntaba las posiciones solo, y mal: guardaba el importe en
      // euros como si fuera el precio de una participación —«1 participación a
      // 500 €»— y encima las daba por compradas antes de que nadie hubiera
      // comprado nada. La cartera quedaba inventada, que para un asesor es
      // peor que no tener cartera.
      //
      // Lo que se apunta ahora es la lista de lo que hay que hacer. Cuando
      // estén hechas de verdad, la cartera se actualiza volviendo a importar
      // la captura del broker, que es donde están los números reales.
      setTradeLog(proposal.trades.map(t => ({ ticker: t.ticker, status: 'pending' as const })));
    }
    setPhase('done');
  };

  const reset = () => { setPhase('idle'); setProposal(null); setCapital(''); setError(''); setTradeLog([]); };

  const pf = PROFILES[profile];

  return (
    <div style={{ height:'100%', overflow:'auto', padding:'24px 28px', display:'flex', flexDirection:'column', alignItems:'center' }}>
      <div style={{ width:'100%', maxWidth:640, display:'flex', flexDirection:'column', gap:20 }}>

        {/* Header */}
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.5em', fontWeight:600, color:C.goldL, marginBottom:4 }}>Invertir con AURUM</div>
          <div style={{ fontSize:'.78em', color:C.muted }}>AURUM analiza el mercado, propone el plan y lo ejecuta. Tú solo dices <strong style={{ color:C.text }}>Sí</strong>.</div>
        </div>

        {/* Panel de análisis de cartera — solo cuando hay posiciones */}
        {portfolio.length > 0 && (phase === 'idle' || phase === 'loading') && (() => {
          const drift = detectDrift(portfolio, profile);
          const risk  = portfolioRiskScore(portfolio);
          const stress = stressTest(portfolio);
          const worst = stress.length ? stress.reduce((a, b) => a.portfolioDropPct < b.portfolioDropPct ? a : b) : null;
          return (
            <Card style={{ padding:'16px 18px', background:`${C.surf3}` }}>
              <div style={{ fontSize:'.62em', letterSpacing:'2px', color:C.muted, textTransform:'uppercase', marginBottom:12 }}>Diagnóstico de cartera</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
                {/* Drift */}
                <div style={{ padding:'10px 12px', background:drift.needsRebal?`${C.red}0a`:`${C.green}0a`, border:`1px solid ${drift.needsRebal?C.red+'33':C.green+'33'}`, borderRadius:9 }}>
                  <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4, letterSpacing:'.5px' }}>Drift</div>
                  <div style={{ fontSize:'1.15em', fontWeight:700, color:drift.needsRebal?C.red:C.green, fontFamily:"'DM Mono',monospace" }}>{drift.driftPct}%</div>
                  <div style={{ fontSize:'.62em', color:C.muted, marginTop:2 }}>{drift.needsRebal ? '⚠ Rebalanceo' : '✓ OK'}</div>
                </div>
                {/* Risk score */}
                <div style={{ padding:'10px 12px', background:`${risk.color}0a`, border:`1px solid ${risk.color}33`, borderRadius:9 }}>
                  <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4, letterSpacing:'.5px' }}>Riesgo</div>
                  <div style={{ fontSize:'1.15em', fontWeight:700, color:risk.color, fontFamily:"'DM Mono',monospace" }}>{risk.score}/100</div>
                  <div style={{ fontSize:'.62em', color:C.muted, marginTop:2 }}>{risk.label}</div>
                </div>
                {/* Worst crash */}
                {worst && (
                  <div style={{ padding:'10px 12px', background:`${C.red}0a`, border:`1px solid ${C.red}22`, borderRadius:9 }}>
                    <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4, letterSpacing:'.5px' }}>Peor crisis</div>
                    <div style={{ fontSize:'1.15em', fontWeight:700, color:C.red, fontFamily:"'DM Mono',monospace" }}>{worst.portfolioDropPct}%</div>
                    <div style={{ fontSize:'.62em', color:C.muted, marginTop:2 }}>{worst.scenario.year}</div>
                  </div>
                )}
              </div>
              {drift.needsRebal && (
                <div style={{ marginTop:10, padding:'8px 10px', background:`${C.red}08`, border:`1px solid ${C.red}22`, borderRadius:7, fontSize:'.68em', color:C.muted, lineHeight:1.5 }}>
                  ⚠️ {drift.message}
                </div>
              )}
            </Card>
          );
        })()}

        {/* Feature 2: Rebalance Card */}
        {portfolio.length > 0 && (phase === 'idle' || phase === 'loading') && (
          <RebalanceCard portfolio={portfolio} profile={profile} onNavigate={onNavigate} />
        )}

        {/* Watchlist */}
        {(phase === 'idle' || phase === 'loading') && <WatchlistCard />}

        {/* Input */}
        {(phase === 'idle' || phase === 'loading') && (
          <Card style={{ padding:'24px' }}>
            <div style={{ fontSize:'.65em', letterSpacing:'2px', color:C.muted, textTransform:'uppercase', marginBottom:14 }}>Capital a invertir</div>
            <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:14 }}>
              <div style={{ position:'relative', flex:1 }}>
                <input
                  type="number" min={10} value={capital}
                  onChange={e => setCapital(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && analyze()}
                  placeholder="500"
                  style={{ ...inputBase, fontSize:'1.6em', padding:'12px 44px 12px 16px', fontFamily:"'DM Mono',monospace", textAlign:'right' }}
                />
                <span style={{ position:'absolute', right:14, top:'50%', transform:'translateY(-50%)', fontSize:'1.1em', color:C.muted, fontFamily:"'DM Mono',monospace" }}>€</span>
              </div>
              <button onClick={analyze} disabled={phase === 'loading' || !capital}
                style={{ padding:'12px 22px', background:capital&&phase!=='loading'?C.gold:'#1a1a28', border:'none', borderRadius:11, color:capital&&phase!=='loading'?'#07070e':C.muted, fontWeight:700, cursor:'pointer', fontSize:'.9em', fontFamily:"'Sora',sans-serif", flexShrink:0, display:'flex', alignItems:'center', gap:8, transition:'all .18s' }}>
                {phase === 'loading' ? <><Spinner/>Analizando…</> : 'Analizar →'}
              </button>
            </div>
            {phase === 'loading' && (
              <div style={{ display:'flex', flexDirection:'column', gap:8, padding:'14px', background:'#07070e', borderRadius:9, border:`1px solid ${C.border}` }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:'.75em', color:C.gold }}><Spinner/>Buscando estado del mercado…</div>
                <div style={{ fontSize:'.68em', color:C.muted }}>AURUM consulta mercados en tiempo real y calcula la asignación óptima para tu perfil {pf.emoji} {pf.label}.</div>
              </div>
            )}
            {error && <div style={{ color:C.red, fontSize:'.75em', padding:'10px 14px', background:'#2a0a0a', borderRadius:8, border:`1px solid ${C.red}33`, marginTop:8 }}>{error}</div>}
            <div style={{ marginTop:14, fontSize:'.68em', color:C.faint }}>
              Perfil activo: {pf.emoji} <span style={{ color:pf.color }}>{pf.label}</span> · {pf.alloc}
            </div>
          </Card>
        )}

        {/* Proposal */}
        {proposal && (phase === 'proposal' || phase === 'executing' || phase === 'done') && (
          <>
            {/* Market context */}
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 14px', background:`${C.blue}0c`, border:`1px solid ${C.blue}33`, borderRadius:9, fontSize:'.75em', color:C.text }}>
              <span style={{ fontSize:'1em', flexShrink:0 }}>🌐</span>
              <span>{proposal.marketContext}</span>
            </div>

            {/* Trades */}
            <Card>
              <div style={{ padding:'14px 16px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <div>
                  <div style={{ fontSize:'.88em', fontWeight:600, color:C.goldL }}>Plan de inversión · {proposal.totalAmount.toLocaleString('es-ES')}€</div>
                  <div style={{ fontSize:'.65em', color:C.muted, marginTop:2 }}>{proposal.trades.length} instrumentos · {new Date(proposal.generatedAt).toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' })}</div>
                </div>
                <ProviderBadge provider="anthropic" model="claude-sonnet-5" />
              </div>
              {proposal.trades.map((t, i) => <TradeRow key={i} trade={t} />)}
              <div style={{ padding:'12px 16px', background:'#07070e', borderTop:`1px solid ${C.border}` }}>
                <div style={{ fontSize:'.72em', color:C.muted, lineHeight:1.6 }}>
                  <span style={{ color:C.gold }}>◈ </span>{proposal.rationale}
                </div>
              </div>
            </Card>

            {/* Estimates */}
            <Card style={{ padding:'16px' }}>
              <div style={{ fontSize:'.65em', letterSpacing:'2px', color:C.muted, textTransform:'uppercase', marginBottom:12 }}>
                Estimación a {proposal.estimates.horizon} años
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                <EstimateBar label="Escenario optimista"  emoji="🚀" pct={proposal.estimates.optimistic}  capital={proposal.totalAmount} />
                <EstimateBar label="Escenario base"       emoji="⚖️" pct={proposal.estimates.base}        capital={proposal.totalAmount} highlight />
                <EstimateBar label="Escenario pesimista"  emoji="🛡️" pct={proposal.estimates.pessimistic} capital={proposal.totalAmount} />
              </div>
              <div style={{ marginTop:10, fontSize:'.62em', color:C.faint }}>⚠️ Estimaciones orientativas basadas en histórico. No garantizan rentabilidad futura.</div>
            </Card>

            {/* Actions */}
            {phase === 'proposal' && (
              <div style={{ display:'flex', gap:10 }}>
                <button onClick={confirm}
                  style={{ flex:1, padding:'14px', background:C.gold, border:'none', borderRadius:12, color:'#07070e', fontWeight:700, cursor:'pointer', fontSize:'1em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                  ✓ Sí, ejecutar
                </button>
                <button onClick={reset}
                  style={{ padding:'14px 20px', background:'transparent', border:`1px solid ${C.border2}`, borderRadius:12, color:C.muted, cursor:'pointer', fontSize:'.88em', fontFamily:"'Sora',sans-serif" }}>
                  Cancelar
                </button>
              </div>
            )}

            {phase === 'executing' && (
              <div style={{ display:'flex', flexDirection:'column', gap:8, padding:'16px', background:`${C.gold}08`, border:`1px solid ${C.gold}33`, borderRadius:12 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}><Spinner /><span style={{ fontSize:'.82em', color:C.gold }}>Ejecutando en Trade Republic…</span></div>
                {proposal?.trades.map((t,i) => (
                  <div key={i} style={{ fontSize:'.72em', color:C.muted, display:'flex', gap:8, alignItems:'center' }}>
                    <Spinner /><span>{t.ticker} · {t.amount}€</span>
                  </div>
                ))}
              </div>
            )}

            {phase === 'done' && proposal && (
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                {backendCfg ? (
                  /* ── Resultados reales del backend ── */
                  <div style={{ padding:'16px 20px', background:`${C.green}0c`, border:`1px solid ${C.green}44`, borderRadius:12 }}>
                    <div style={{ fontSize:'.88em', fontWeight:600, color:C.green, marginBottom:12 }}>
                      ✓ Órdenes enviadas a Trade Republic
                    </div>
                    {tradeLog.map((r, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 0', borderBottom:`1px solid ${C.border}22`, fontSize:'.78em' }}>
                        <span style={{ fontSize:'1em' }}>{r.status==='ok'?'✅':r.status==='error'?'❌':'⏳'}</span>
                        <span style={{ color:C.gold, fontFamily:"'DM Mono',monospace", fontWeight:600 }}>{r.ticker}</span>
                        <span style={{ color:r.status==='error'?C.red:C.muted, flex:1 }}>{r.msg || (r.status==='ok'?'ejecutada':'pendiente')}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  /* ── Sin backend: guía manual ── */
                  <div style={{ padding:'16px 20px', background:`${C.blue}0c`, border:`1px solid ${C.blue}33`, borderRadius:12 }}>
                    <div style={{ fontSize:'.88em', fontWeight:600, color:C.blue, marginBottom:8 }}>Plan listo — ejecútalo en Trade Republic</div>
                    <div style={{ fontSize:'.72em', color:C.muted, marginBottom:10, lineHeight:1.55 }}>
                      Tu cartera no se ha tocado: estas órdenes todavía no existen. Cuando las
                      hayas hecho, vuelve a <strong style={{ color:C.text }}>importar la captura</strong> de
                      tu broker en Cartera y quedará con los números reales.
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', gap:7, marginTop:6 }}>
                      {proposal.trades.map((t, i) => (
                        <div key={i} style={{ fontSize:'.75em', color:C.text, display:'flex', gap:8 }}>
                          <span style={{ color:C.gold, flexShrink:0, fontWeight:700 }}>{i+1}.</span>
                          <span>Busca <strong style={{ fontFamily:"'DM Mono',monospace", color:C.gold }}>{t.ticker}</strong> → Comprar → <strong>{t.amount}€</strong> → Confirmar</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop:12, fontSize:'.65em', color:C.faint, padding:'8px 10px', background:'#0a0a14', borderRadius:7 }}>
                      💡 Conecta el backend de Proxmox en Ajustes para que AURUM lo ejecute automáticamente.
                    </div>
                  </div>
                )}
                <button onClick={reset}
                  style={{ padding:'11px', background:`${C.gold}18`, border:`1px solid ${C.gold}44`, borderRadius:10, color:C.gold, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif" }}>
                  Nueva inversión
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS TAB
══════════════════════════════════════════════════════════════ */
/**
 * Comprueba la direccion antes de intentar conectar, para poder explicar el
 * fallo mas comun —contenido mixto— que de otro modo aparece como un error de
 * red generico y deja al usuario sin pista de que hacer.
 */
function revisarDireccion(valor: string): string | null {
  const u = valor.trim();
  if (!u) return 'Escribe la dirección del backend.';

  let dir: URL;
  try { dir = new URL(u); }
  catch { return 'Esa dirección no es válida. Tiene que empezar por http:// o https://'; }

  const esLocal = ['localhost', '127.0.0.1', '[::1]'].includes(dir.hostname);
  if (window.location.protocol === 'https:' && dir.protocol === 'http:' && !esLocal) {
    return 'El navegador va a bloquear esta conexión. AURUM se sirve por https y esa dirección '
         + 'es http: solo se permite si es localhost. Desde el móvil necesitas una dirección '
         + 'https — con Tailscale, por ejemplo. Está explicado en docs/BACKEND.md.';
  }
  return null;
}

function BackendSection() {
  const [url,        setUrl]        = useState('');
  const [apiKey,     setApiKey]     = useState('');
  const [status,     setStatus]     = useState<'idle'|'ok'|'error'>('idle');
  const [statusMsg,  setStatusMsg]  = useState('');
  const [trSesion,   setTrSesion]   = useState('');
  const [authPhase,  setAuthPhase]  = useState<'idle'|'done'>('idle');
  const [comoVa,     setComoVa]     = useState(false);
  const [authMsg,    setAuthMsg]    = useState('');
  const fs: React.CSSProperties    = { ...inputBase, padding:'8px 12px' };

  // Esta clave no tiene espejo en el dispositivo —lleva un token—, asi que si
  // la carga inicial no la trajo, aqui no hay nada que enseñar. En ese caso se
  // vuelve a pedir al servidor en vez de dejar los campos en blanco, que se lee
  // como si la configuracion se hubiera perdido.
  useEffect(() => {
    let vigente = true;
    (async () => {
      const cfg = await sGet<{ url?:string; apiKey?:string }>('aurum-backend-config')
        ?? await store.recargarConfigBackend();
      if (!vigente || !cfg) return;
      if (cfg.url)    setUrl(cfg.url);
      if (cfg.apiKey) setApiKey(cfg.apiKey);
    })();
    return () => { vigente = false; };
  }, []);

  const testConnection = async () => {
    const problema = revisarDireccion(url);
    if (problema) { setStatus('error'); setStatusMsg(problema); return; }

    setStatus('idle'); setStatusMsg('Conectando…');
    try {
      const res = await backendCall({ url, apiKey }, '/health');
      if (res.status !== 'ok') { setStatus('error'); setStatusMsg('Ha respondido algo que no parece un backend de AURUM. Revisa la dirección.'); return; }

      // /health no pide token: comprobar solo eso daria por buena una
      // configuracion con el token equivocado, y el fallo apareceria despues,
      // al intentar leer la cartera. Se valida tambien la credencial.
      const quien = await backendCall({ url, apiKey }, '/me');

      setStatus('ok');
      // Decir qué permite el token evita la confusión de descubrir más tarde,
      // sin explicación, que una pantalla no responde. El de la aplicación es
      // de solo lectura a propósito.
      const soloLectura = Array.isArray(quien.scopes)
        && quien.scopes.length === 1 && quien.scopes[0] === 'read';
      const alcance = soloLectura ? ' Token de solo lectura.' : '';
      setStatusMsg(res.tr_authenticated
        ? `✓ Conectado como ${quien.user_email}. Trade Republic ya está enlazado.${alcance}`
        : `✓ Conectado como ${quien.user_email}. Falta enlazar Trade Republic, aquí abajo.${alcance}`);
      await sSet('aurum-backend-config', { url, apiKey });
    } catch(e:any) {
      setStatus('error');
      // Un fetch que no llega lanza TypeError sin detalle: el navegador no dice
      // por que, asi que hay que explicarle al usuario las causas posibles.
      const msg = String(e?.message ?? e);
      if (e instanceof TypeError || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setStatusMsg('No se ha podido contactar. O el backend no está arrancado, o la dirección no es esa. '
          + 'Si lo instalaste en este mismo ordenador, prueba con http://localhost:8000');
      } else if (msg.startsWith('401')) {
        setStatusMsg('El token no vale para este backend. Si lo has perdido, borra backend/aurum.db y vuelve a ejecutar el instalador.');
      } else if (msg.startsWith('403')) {
        setStatusMsg('Ese token no tiene permiso para esta operación.');
      } else {
        setStatusMsg(msg);
      }
    }
  };

  // Trade Republic puso su anti-bot delante de todos sus accesos, así que
  // AURUM ya no puede entrar por sí solo con teléfono y PIN. Lo que sí puede
  // es usar una sesión que hayas abierto tú: el anti-bot vigila *entrar*, no
  // *usar* una sesión ya abierta. Por eso ya no hay formulario de credenciales
  // — dejarlo puesto sería prometer algo que no funciona.
  const enlazarSesion = async () => {
    setAuthMsg('Comprobando la sesión con Trade Republic…');
    try {
      await backendCall({ url, apiKey }, '/auth/session', 'POST', { cookies: trSesion });
      setAuthPhase('done');
      setAuthMsg('Trade Republic enlazado. AURUM ya puede leer tu cartera.');
      setTrSesion('');
    } catch (e: any) {
      setAuthMsg(`Error: ${String(e?.message ?? e)}`);
    }
  };

  const statusColor = status === 'ok' ? C.green : status === 'error' ? C.red : C.muted;

  return (
    <div>
      <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.18em', fontWeight:600, color:C.goldL, marginBottom:4 }}>
        Tu backend <span style={{ fontSize:'.62em', fontFamily:"'Sora',sans-serif", fontWeight:400, color:C.muted, letterSpacing:'1px', textTransform:'uppercase' }}>opcional</span>
      </div>
      <div style={{ fontSize:'.74em', color:C.muted, marginBottom:14, lineHeight:1.5 }}>
        <strong style={{ color:C.text }}>No hace falta para usar AURUM.</strong> El chat con los agentes,
        Research, el simulador y la cartera llevada a mano funcionan sin nada de esto.
        <br /><br />
        Esto sirve para una cosa concreta: que AURUM vea tu <strong style={{ color:C.text }}>cartera
        real de Trade Republic</strong> en lugar de que la escribas tú. Es un programa que corre en tu
        ordenador; tus credenciales se quedan ahí, cifradas, y no salen de tu máquina. Se instala
        ejecutando<code style={{ color:C.text }}> instalar.ps1 </code>(Windows) o
        <code style={{ color:C.text }}> instalar.sh </code>(Linux y macOS) dentro de la carpeta
        <code style={{ color:C.text }}> backend</code>; al terminar te da la dirección y el token
        que van aquí abajo.
      </div>
      <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'18px 20px', display:'flex', flexDirection:'column', gap:14 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div>
            <div style={{ fontSize:'.65em', color:C.muted, marginBottom:5 }}>Dirección</div>
            <input value={url} onChange={e=>setUrl(e.target.value)} placeholder="http://localhost:8000" style={fs} />
          </div>
          <div>
            <div style={{ fontSize:'.65em', color:C.muted, marginBottom:5 }}>Token de acceso</div>
            <input value={apiKey} onChange={e=>setApiKey(e.target.value)} type="password" placeholder="••••••••••••••••" style={fs} />
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <button onClick={testConnection} style={{ background:`${C.blue}18`, border:`1px solid ${C.blue}44`, borderRadius:8, padding:'7px 16px', color:C.blue, cursor:'pointer', fontSize:'.78em', fontFamily:"'Sora',sans-serif" }}>
            Probar conexión
          </button>
          {statusMsg && <span style={{ fontSize:'.72em', color:statusColor }}>{statusMsg}</span>}
        </div>

        {/* TR Auth */}
        {status === 'ok' && authPhase !== 'done' && (
          <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:14 }}>
            <div style={{ fontSize:'.68em', color:C.muted, marginBottom:10, letterSpacing:'1px', textTransform:'uppercase' }}>Enlazar Trade Republic</div>

            <div style={{ fontSize:'.7em', color:C.muted, lineHeight:1.6, marginBottom:12 }}>
              Trade Republic bloquea que un programa entre con tu teléfono y tu PIN: exige
              resolver un control anti-robots pensado para distinguir personas de programas.
              AURUM no lo hace por ti — <strong style={{ color:C.text }}>entras tú, y le cedes
              tu propia sesión</strong>.
              <button
                onClick={() => setComoVa(v => !v)}
                style={{ background:'none', border:'none', color:C.blue, cursor:'pointer', padding:0, marginLeft:6, fontSize:'1em', fontFamily:'inherit', textDecoration:'underline' }}
              >
                {comoVa ? 'ocultar los pasos' : '¿cómo se saca?'}
              </button>
            </div>

            {comoVa && (
              <>
              <ol style={{ fontSize:'.68em', color:C.muted, lineHeight:1.8, margin:'0 0 12px', paddingLeft:20 }}>
                <li>Entra en <code style={{ color:C.text }}>app.traderepublic.com</code> en este navegador, como cualquier día.</li>
                <li>Pulsa <strong style={{ color:C.text }}>F12</strong> y ve a la pestaña <strong style={{ color:C.text }}>Red</strong> (o <em>Network</em>).</li>
                <li>Recarga la página y busca cualquier petición a <code style={{ color:C.text }}>api.traderepublic.com</code>.</li>
                <li><strong style={{ color:C.text }}>Clic derecho</strong> sobre ella → <strong style={{ color:C.text }}>Copiar</strong> → <strong style={{ color:C.text }}>Copiar como cURL</strong>.</li>
                <li>Pega eso aquí abajo, tal cual. AURUM saca de dentro lo que necesita.</li>
              </ol>
              <div style={{ fontSize:'.66em', color:C.muted, lineHeight:1.6, margin:'0 0 12px' }}>
                Se pega el cURL entero a propósito: Trade Republic comprueba varias galletas a
                la vez —incluida la del control anti-robots— y así no hay que adivinar cuáles.
                También vale pegar solo la línea <code style={{ color:C.text }}>Cookie:</code> si
                prefieres buscarla.
              </div>
              </>
            )}

            {/* El bloque de fuera ya solo se pinta cuando falta enlazar. */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:8, alignItems:'end' }}>
                <div>
                  <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>Sesión de Trade Republic</div>
                  <input
                    value={trSesion}
                    onChange={e => setTrSesion(e.target.value)}
                    type="password"
                    placeholder="pega aquí el cURL, o la línea Cookie"
                    autoComplete="off"
                    style={{ ...fs, padding:'7px 10px' }}
                  />
                </div>
                <button
                  onClick={enlazarSesion}
                  disabled={!trSesion.trim()}
                  style={{ background: trSesion.trim() ? C.gold : `${C.gold}44`, border:'none', borderRadius:8, padding:'7px 16px', color:'#07070e', fontWeight:600, cursor: trSesion.trim() ? 'pointer' : 'default', fontSize:'.78em', fontFamily:"'Sora',sans-serif", whiteSpace:'nowrap' }}
                >
                  Enlazar →
                </button>
            </div>

            <div style={{ fontSize:'.66em', color:C.muted, marginTop:10, lineHeight:1.5 }}>
              Se guarda cifrada en tu backend, igual que el resto. Cuando caduque, AURUM te
              lo dirá y bastará con repetir estos pasos.
            </div>

            {authMsg && <div style={{ fontSize:'.7em', color:C.muted, marginTop:8 }}>{authMsg}</div>}
          </div>
        )}
        {authPhase === 'done' && (
          <div style={{ fontSize:'.72em', color:C.green, padding:'8px 12px', background:`${C.green}0c`, borderRadius:8, border:`1px solid ${C.green}33` }}>
            ✓ {authMsg}
          </div>
        )}
      </div>

      {/* Local Agent setup */}
      <div style={{ marginTop:18 }}>
        <div style={{ fontSize:'.72em', color:C.goldL, fontWeight:700, marginBottom:8, letterSpacing:'.5px' }}>🖥️ AGENTE LOCAL (control de tu PC)</div>
        <div style={{ fontSize:'.7em', color:C.muted, marginBottom:10, lineHeight:1.5 }}>
          Para que AURUM controle aplicaciones y navegadores <strong style={{ color:C.text }}>directamente en tu ordenador</strong>, ejecuta este script en tu PC:
        </div>
        <div style={{ background:'#0a0a1a', border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 14px', fontSize:'.68em', fontFamily:"'DM Mono',monospace", color:'#8ad8a8', lineHeight:1.8 }}>
          <span style={{ color:C.faint }}># 1. Instalar dependencias (solo la primera vez)</span><br/>
          pip install pyautogui mss pillow httpx<br/><br/>
          <span style={{ color:C.faint }}># 2. Lanzar el agente</span><br/>
          python local_agent.py \<br/>
          {'  '}--server <span style={{ color:C.gold }}>{url || 'http://TU-BACKEND:8000'}</span> \<br/>
          {'  '}--key <span style={{ color:C.gold }}>{apiKey ? '••••••' : 'TU_API_KEY'}</span>
        </div>
        <div style={{ fontSize:'.65em', color:C.faint, marginTop:6 }}>
          El agente corre en segundo plano y permite a AURUM hacer screenshots, clics, escribir texto y abrir apps en tu PC.
        </div>
      </div>
    </div>
  );
}

function AutonomousSection({ profile }: { profile: string }) {
  const [monCfg,  setMonCfg]  = useState<AutonomousConfig>(() => loadAutonomousConfig());
  const [autoCfg, setAutoCfg] = useState<AutoInvestConfig>(() => loadAutoConfig());
  const [perf,    setPerf]    = useState(() => evaluateAurumPerformance());
  const [log,     setLog]     = useState<ActionLogEntry[]>(() => [...loadActionLog()].reverse().slice(0, 10));
  const [lessons, setLessons] = useState<Lesson[]>(() => loadLessons());
  const [syncMsg,   setSyncMsg]   = useState('');
  const [runMsg,    setRunMsg]    = useState('');
  const [running,   setRunning]   = useState(false);
  const [backendLog, setBackendLog] = useState<any[]>([]);
  const [backendStatus, setBackendStatus] = useState<any>(null);
  const fs: React.CSSProperties = { ...inputBase, padding:'8px 12px' };

  const updateMon  = (patch: Partial<AutonomousConfig>) => { const n = {...monCfg,...patch}; setMonCfg(n); saveAutonomousConfig(n); };
  const updateAuto = (patch: Partial<AutoInvestConfig>) => { const n = {...autoCfg,...patch}; setAutoCfg(n); saveAutoConfig(n); };

  const Toggle = ({ val, onChange, label, danger }: { val:boolean; onChange:(v:boolean)=>void; label:string; danger?:boolean }) => (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 0', borderBottom:`1px solid ${C.border}22` }}>
      <span style={{ fontSize:'.78em', color: danger && val ? '#e8734a' : C.text }}>{label}</span>
      <button onClick={() => onChange(!val)} style={{
        width:38, height:20, borderRadius:10, border:'none', cursor:'pointer', transition:'all .2s',
        background: val ? (danger?'#e8734a':C.gold) : C.faint, position:'relative', flexShrink:0,
      }}>
        <div style={{ position:'absolute', top:2, left: val?18:2, width:16, height:16, borderRadius:'50%', background:'#fff', transition:'left .2s' }} />
      </button>
    </div>
  );

  const syncBackend = async () => {
    const cfg = await sGet('aurum-backend-config');
    if (!cfg?.url) { setSyncMsg('Sin backend configurado'); return; }
    setSyncMsg('Sincronizando…');
    try {
      // Mapas de perfil → asignación objetivo
      const allocMap: Record<string,string> = {
        conservador: '40% renta variable, 40% bonos/renta fija, 20% liquidez',
        moderado:    '65% renta variable, 25% bonos, 10% alternativos/oro',
        agresivo:    '90% renta variable diversificada, 10% activos alternativos',
      };
      const res = await fetch(`${cfg.url.replace(/\/$/,'')}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'X-AURUM-KEY': cfg.apiKey },
        body: JSON.stringify({
          enabled:        autoCfg.enabled,
          interval_hours: autoCfg.runInterval === 'daily' ? 24 : autoCfg.runInterval === 'weekly' ? 168 : 720,
          max_amount:     autoCfg.maxAmountPerRun,
          profile,
          target_alloc:   allocMap[profile] || '',
          user_goals:     '',
        }),
      });
      if (res.ok) {
        setSyncMsg('✓ Backend sincronizado con tu perfil');
        await fetchBackendLog(cfg);
      } else { setSyncMsg(`Error ${res.status}`); }
    } catch(e:any) { setSyncMsg(`Error: ${e.message}`); }
    setTimeout(() => setSyncMsg(''), 4000);
  };

  const fetchBackendLog = async (cfgOverride?: any) => {
    const cfg = cfgOverride || await sGet('aurum-backend-config');
    if (!cfg?.url) return;
    try {
      const r = await fetch(`${cfg.url.replace(/\/$/,'')}/auto-log`, { headers: { 'X-AURUM-KEY': cfg.apiKey } });
      if (r.ok) {
        const data = await r.json();
        setBackendLog(data.log || []);
        setBackendStatus(data);
      }
    } catch { /* sin backend */ }
  };

  useEffect(() => { fetchBackendLog(); }, []);

  const runNow = async () => {
    const cfg = await sGet('aurum-backend-config');
    if (!cfg?.url) { setRunMsg('Sin backend configurado'); return; }
    if (!cfg.apiKey) { setRunMsg('Sin API key'); return; }
    setRunning(true); setRunMsg('');
    try {
      const r = await fetch(`${cfg.url.replace(/\/$/,'')}/run-now`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'X-AURUM-KEY': cfg.apiKey },
        body: JSON.stringify({ reason: 'disparo manual desde la app' }),
      });
      const data = await r.json();
      if (r.ok) {
        const action = data.action || 'hold';
        if (action === 'hold') {
          setRunMsg(`⏸ Decisión: mantener. ${data.reasoning?.slice(0,80) || ''}`);
        } else {
          const total = data.total_exec || 0;
          setRunMsg(`✅ Ejecutado: ${total.toFixed(0)}€ invertidos`);
        }
        await fetchBackendLog(cfg);
      } else { setRunMsg(`Error ${r.status}: ${JSON.stringify(data).slice(0,80)}`); }
    } catch(e:any) { setRunMsg(`Error: ${e.message}`); }
    setRunning(false);
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

      {/* Monitorización de alertas */}
      <div>
        <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.18em', fontWeight:600, color:C.goldL, marginBottom:4 }}>Monitorización Autónoma</div>
        <div style={{ fontSize:'.74em', color:C.muted, marginBottom:12 }}>AURUM vigila tu cartera en segundo plano y genera alertas.</div>
        <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'16px 18px', display:'flex', flexDirection:'column', gap:2 }}>
          <Toggle val={monCfg.enabled}      onChange={v=>updateMon({enabled:v})}      label="Monitor activo" />
          <Toggle val={monCfg.alertOnDrift} onChange={v=>updateMon({alertOnDrift:v})} label="Alertar en desvío de asignación" />
          <Toggle val={monCfg.alertOnRisk}  onChange={v=>updateMon({alertOnRisk:v})}  label="Alertar en riesgo elevado" />
          <Toggle val={monCfg.alertOnLoss}  onChange={v=>updateMon({alertOnLoss:v})}  label="Alertar en pérdidas significativas" />
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginTop:8 }}>
            <div>
              <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>Intervalo (min)</div>
              <input type="number" min={15} value={monCfg.monitorInterval} onChange={e=>updateMon({monitorInterval:parseInt(e.target.value)||60})} style={{...fs,padding:'6px 10px'}} />
            </div>
            <div>
              <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>Umbral pérdida (%)</div>
              <input type="number" max={0} value={monCfg.lossThreshold} onChange={e=>updateMon({lossThreshold:parseFloat(e.target.value)||-10})} style={{...fs,padding:'6px 10px'}} />
            </div>
          </div>
        </div>
      </div>

      {/* Modo autónomo total — AURUM actúa solo */}
      <div>
        <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.18em', fontWeight:600, color:C.goldL, marginBottom:4 }}>Modo Autónomo Total 🤖</div>
        <div style={{ fontSize:'.74em', color:C.muted, marginBottom:12 }}>AURUM analiza el mercado, decide y ejecuta inversiones sin que hagas nada.</div>
        <div style={{ background:autoCfg.enabled && !autoCfg.requireConfirm ? `${C.gold}08` : C.surf2, border:`1px solid ${autoCfg.enabled && !autoCfg.requireConfirm ? C.gold+'44' : C.border}`, borderRadius:13, padding:'16px 18px', display:'flex', flexDirection:'column', gap:2 }}>
          <Toggle val={autoCfg.enabled}        onChange={v=>updateAuto({enabled:v})}         label="Auto-inversión activa" />
          <Toggle val={!autoCfg.requireConfirm} onChange={v=>updateAuto({requireConfirm:!v})} label="Ejecutar sin confirmación (modo total)" danger />
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginTop:8 }}>
            <div>
              <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>Presupuesto máx/ciclo (€)</div>
              <input type="number" min={10} value={autoCfg.maxAmountPerRun} onChange={e=>updateAuto({maxAmountPerRun:parseFloat(e.target.value)||100})} style={{...fs,padding:'6px 10px'}} />
            </div>
            <div>
              <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>Frecuencia</div>
              <select value={autoCfg.runInterval} onChange={e=>updateAuto({runInterval:e.target.value as any})}
                style={{...fs,padding:'6px 10px',cursor:'pointer'}}>
                <option value="daily">Diario</option>
                <option value="weekly">Semanal</option>
                <option value="monthly">Mensual</option>
              </select>
            </div>
          </div>
          {!autoCfg.requireConfirm && (
            <div style={{ marginTop:8, padding:'8px 10px', background:`${C.red}0a`, border:`1px solid ${C.red}22`, borderRadius:8, fontSize:'.68em', color:'#e8734a', lineHeight:1.5 }}>
              ⚠️ Modo total activo: AURUM ejecutará órdenes en TR automáticamente, sin pedirte confirmación. Asegúrate de que el backend está autenticado y el presupuesto es el que quieres.
            </div>
          )}
          {/* Botones de control */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:12 }}>
            <button onClick={syncBackend} style={{ background:`${C.blue}18`, border:`1px solid ${C.blue}44`, borderRadius:8, padding:'7px 14px', color:C.blue, cursor:'pointer', fontSize:'.75em', fontFamily:"'Sora',sans-serif" }}>
              ⚙️ Sincronizar configuración
            </button>
            <button onClick={runNow} disabled={running}
              style={{ background:running?'#1a1a28':`${C.gold}18`, border:`1px solid ${running?C.border:C.gold+'55'}`, borderRadius:8, padding:'7px 14px', color:running?C.muted:C.gold, cursor:running?'not-allowed':'pointer', fontSize:'.75em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', gap:6 }}>
              {running ? <><Spinner/>Ejecutando…</> : '🚀 Ejecutar Ahora'}
            </button>
            <button onClick={() => fetchBackendLog()} style={{ background:'transparent', border:`1px solid ${C.border2}`, borderRadius:8, padding:'7px 14px', color:C.muted, cursor:'pointer', fontSize:'.75em', fontFamily:"'Sora',sans-serif" }}>
              ↺ Actualizar log
            </button>
          </div>
          {syncMsg && <div style={{ fontSize:'.7em', color: syncMsg.startsWith('✓') ? C.green : syncMsg.includes('Error') ? C.red : C.muted, marginTop:6 }}>{syncMsg}</div>}
          {runMsg  && <div style={{ fontSize:'.7em', color: runMsg.startsWith('✅') ? C.green : runMsg.startsWith('⏸') ? C.gold : C.red, marginTop:4, lineHeight:1.4 }}>{runMsg}</div>}
        </div>
      </div>

      {/* ── Panel de estado del backend ──────────────────────── */}
      {backendStatus && (
        <div style={{ background:`${backendStatus.auto_enabled ? C.green : C.faint}08`, border:`1px solid ${backendStatus.auto_enabled ? C.green+'33' : C.border}`, borderRadius:13, padding:'14px 18px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background: backendStatus.auto_enabled ? C.green : C.muted, boxShadow: backendStatus.auto_enabled ? `0 0 8px ${C.green}` : 'none' }} />
            <span style={{ fontSize:'.8em', fontWeight:600, color: backendStatus.auto_enabled ? C.green : C.muted }}>
              Backend autónomo {backendStatus.auto_enabled ? 'ACTIVO 🤖' : 'inactivo'}
            </span>
            <span style={{ fontSize:'.68em', color:C.faint, marginLeft:'auto' }}>
              Perfil: {backendStatus.profile || '—'} · Máx: {backendStatus.max_amount || 0}€/{backendStatus.interval_h || 168}h
            </span>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <div style={{ padding:'8px 12px', background:C.surf3, borderRadius:8 }}>
              <div style={{ fontSize:'.58em', color:C.muted, marginBottom:3 }}>Último ciclo</div>
              <div style={{ fontSize:'.78em', color:C.text, fontFamily:"'DM Mono',monospace" }}>
                {backendStatus.last_run ? new Date(backendStatus.last_run).toLocaleString('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'}
              </div>
            </div>
            <div style={{ padding:'8px 12px', background:C.surf3, borderRadius:8 }}>
              <div style={{ fontSize:'.58em', color:C.muted, marginBottom:3 }}>Próximo ciclo</div>
              <div style={{ fontSize:'.78em', color:C.gold, fontFamily:"'DM Mono',monospace" }}>
                {backendStatus.next_run ? new Date(backendStatus.next_run).toLocaleString('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'}
              </div>
            </div>
          </div>

          {/* Log del backend */}
          {backendLog.length > 0 && (
            <div style={{ marginTop:12 }}>
              <div style={{ fontSize:'.62em', letterSpacing:'1.5px', color:C.muted, textTransform:'uppercase', marginBottom:8 }}>Historial del backend</div>
              <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                {backendLog.slice(0,8).map((entry,i) => {
                  const isInvest = entry.type === 'invest' || entry.type === 'rebalance';
                  const hasTrades = Array.isArray(entry.trades) && entry.trades.length > 0;
                  return (
                    <div key={i} style={{ padding:'8px 12px', background:C.surf3, border:`1px solid ${isInvest&&hasTrades ? C.green+'22' : C.border}`, borderRadius:8 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                        <span style={{ fontSize:'.85em' }}>{isInvest && hasTrades ? '✅' : '⏸️'}</span>
                        <span style={{ fontSize:'.75em', fontWeight:600, color: isInvest && hasTrades ? C.green : C.muted }}>
                          {entry.type?.toUpperCase() || 'HOLD'}
                        </span>
                        {hasTrades && <span style={{ fontSize:'.68em', color:C.gold, fontFamily:"'DM Mono',monospace" }}>
                          {(entry.trades as any[]).filter(t=>t.status==='ok').map((t:any)=>t.ticker).join(', ')} · {entry.total?.toFixed(0) || 0}€
                        </span>}
                        <span style={{ fontSize:'.6em', color:C.faint, marginLeft:'auto' }}>
                          {entry.ts ? new Date(entry.ts).toLocaleString('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : ''}
                        </span>
                      </div>
                      {entry.reasoning && <div style={{ fontSize:'.67em', color:C.muted, marginTop:3, lineHeight:1.4 }}>{entry.reasoning.slice(0,120)}</div>}
                      {entry.trigger && <div style={{ fontSize:'.62em', color:C.faint, marginTop:2 }}>🔁 {entry.trigger}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Log de acciones autónomas (frontend) */}
      {log.length > 0 && (
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.1em', fontWeight:600, color:C.goldL, marginBottom:10 }}>Log de Acciones (app)</div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {log.map(entry => (
              <div key={entry.id} style={{ padding:'10px 12px', background:C.surf2, border:`1px solid ${entry.executed?C.green+'33':C.border}`, borderRadius:9 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                  <span style={{ fontSize:'.75em' }}>{entry.executed ? '✅' : '📋'}</span>
                  <span style={{ fontSize:'.75em', fontWeight:600, color: entry.executed ? C.green : C.muted, textTransform:'capitalize' }}>{entry.decisionType}</span>
                  {entry.trades.length > 0 && <span style={{ fontSize:'.7em', color:C.gold, fontFamily:"'DM Mono',monospace" }}>{entry.trades.map(t=>t.ticker).join(', ')}</span>}
                  <span style={{ fontSize:'.62em', color:C.faint, marginLeft:'auto' }}>{new Date(entry.executedAt).toLocaleString('es-ES',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
                </div>
                <div style={{ fontSize:'.68em', color:C.muted, lineHeight:1.4 }}>{entry.reasoning}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rendimiento de AURUM */}
      {perf.totalRecs > 0 && (
        <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'16px 18px' }}>
          <div style={{ fontSize:'.75em', fontWeight:600, color:C.goldL, marginBottom:10 }}>Rendimiento de AURUM</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:10 }}>
            {[
              { n:perf.totalRecs, label:'Total recom.', color:C.gold },
              { n:perf.executedRecs, label:'Ejecutadas', color:C.green },
              { n:perf.accuracy, label:'Precisión %', color: perf.accuracy>=70?C.green:'#e8734a' },
            ].map(({ n, label, color }) => (
              <div key={label} style={{ textAlign:'center', padding:'8px', background:'#0a0a14', borderRadius:8 }}>
                <div style={{ fontSize:'1.3em', fontWeight:700, color, fontFamily:"'DM Mono',monospace" }}>{n}</div>
                <div style={{ fontSize:'.58em', color:C.muted }}>{label}</div>
              </div>
            ))}
          </div>
          {perf.withActualData > 0 && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 }}>
              <div style={{ padding:'7px 10px', background:`${C.blue}08`, border:`1px solid ${C.blue}22`, borderRadius:7 }}>
                <div style={{ fontSize:'.58em', color:C.muted }}>Estimado medio</div>
                <div style={{ fontSize:'.9em', fontWeight:600, color:C.blue, fontFamily:"'DM Mono',monospace" }}>{perf.avgEstimated>=0?'+':''}{perf.avgEstimated}%</div>
              </div>
              <div style={{ padding:'7px 10px', background:`${C.green}08`, border:`1px solid ${C.green}22`, borderRadius:7 }}>
                <div style={{ fontSize:'.58em', color:C.muted }}>Real medio</div>
                <div style={{ fontSize:'.9em', fontWeight:600, color:C.green, fontFamily:"'DM Mono',monospace" }}>{perf.avgActual>=0?'+':''}{perf.avgActual}%</div>
              </div>
            </div>
          )}
          <div style={{ fontSize:'.68em', color:C.muted, lineHeight:1.5 }}>◆ {perf.verdict}</div>
        </div>
      )}

      {/* Lecciones aprendidas */}
      {lessons.length > 0 && (
        <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'16px 18px' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
            <div style={{ fontSize:'.75em', fontWeight:600, color:C.goldL }}>Lecciones aprendidas por AURUM</div>
            <button onClick={() => { clearLessons(); setLessons([]); }}
              style={{ background:'transparent', border:`1px solid ${C.border2}`, color:C.muted, cursor:'pointer', fontSize:'.62em', borderRadius:6, padding:'2px 8px', fontFamily:"'Sora',sans-serif" }}>
              Reset
            </button>
          </div>
          {lessons.map((l, i) => (
            <div key={i} style={{ display:'flex', gap:8, marginBottom:7, padding:'7px 10px', background:'#0a0a14', border:`1px solid ${C.border}`, borderRadius:7, fontSize:'.72em', color:C.text, lineHeight:1.5 }}>
              <span style={{ color:C.gold, flexShrink:0 }}>◆</span>{l.text}
              <span style={{ marginLeft:'auto', fontSize:'.75em', color:C.faint, flexShrink:0 }}>{Math.round(l.confidence*100)}%</span>
            </div>
          ))}
          <div style={{ fontSize:'.62em', color:C.faint, marginTop:4 }}>Se actualizan semanalmente si hay ≥2 recomendaciones con rendimiento real registrado.</div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   CONTROL TAB — Computer-use: navegador + agente local
══════════════════════════════════════════════════════════════ */
function ControlTab() {
  const [task,       setTask]       = useState('');
  const [url,        setUrl]        = useState('');
  const [running,    setRunning]    = useState(false);
  const [result,     setResult]     = useState<ComputerTaskResult|null>(null);
  const [mode,       setMode]       = useState<'browser'|'local'>('browser');
  const [agentOnline,setAgentOnline]= useState<boolean|null>(null);
  const [history,    setHistory]    = useState<Array<{task:string;ok:boolean;result:string;ts:number}>>([]);

  useEffect(() => {
    getBackendConfig().then(cfg => {
      if (!cfg) { setAgentOnline(false); return; }
      getAgentStatus(cfg).then(s => setAgentOnline(s.connected));
    });
  }, []);

  const run = async () => {
    if (!task.trim() || running) return;
    const cfg = await getBackendConfig();
    if (!cfg) { alert('Configura el backend en Ajustes primero.'); return; }
    setRunning(true); setResult(null);
    try {
      const r = mode === 'browser'
        ? await runBrowserTask(task, url, cfg)
        : await runLocalAgentTask(task, cfg);
      setResult(r);
      setHistory(h => [{ task, ok: r.success, result: r.result, ts: Date.now() }, ...h].slice(0, 20));
    } catch(e:any) {
      setResult({ success: false, result: e?.message || String(e) });
    } finally { setRunning(false); }
  };

  const PRESETS = [
    { label:'📊 Saldo Revolut', task:'Navega a revolut.com/app, inicia sesión y extrae mi saldo actual', url:'https://app.revolut.com/start' },
    { label:'💶 Transferir 50€', task:'Transfiere 50€ a mi contacto habitual', url:'https://app.revolut.com/start' },
    { label:'📈 Saldo N26', task:'Inicia sesión en N26 y extrae mi saldo y últimas transacciones', url:'https://app.n26.com/login' },
    { label:'🏦 Saldo Banco', task:'Accede a mi banca online y extrae el saldo de mis cuentas', url:'' },
    { label:'📱 Captura pantalla', task:'Toma una screenshot del escritorio actual', url:'' },
    { label:'💻 Apps abiertas', task:'Lista qué aplicaciones están abiertas ahora mismo', url:'' },
  ];

  return (
    <div style={{ padding:'16px', overflowY:'auto', height:'100%' }}>
      <div style={{ marginBottom:16 }}>
        <div style={{ fontSize:'.68em', color:C.gold, letterSpacing:'1px', fontWeight:700, marginBottom:4 }}>CONTROL DE PC / NAVEGADOR</div>
        <div style={{ fontSize:'.72em', color:C.muted }}>AURUM controla tu ordenador y aplicaciones financieras de forma autónoma.</div>
      </div>

      {/* Mode selector */}
      <div style={{ display:'flex', gap:8, marginBottom:14 }}>
        {(['browser','local'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            flex:1, padding:'8px 0', borderRadius:8,
            background: mode===m ? `${C.gold}22` : C.surf2,
            border:`1px solid ${mode===m ? C.gold : C.border}`,
            color: mode===m ? C.gold : C.muted, fontSize:'.72em', cursor:'pointer',
          }}>
            {m === 'browser' ? '🌐 Navegador (servidor)' : '🖥️ PC local'}
            {m === 'local' && (
              <span style={{ marginLeft:6, color: agentOnline ? C.green : C.red, fontSize:'.85em' }}>
                {agentOnline === null ? '…' : agentOnline ? '● online' : '● offline'}
              </span>
            )}
          </button>
        ))}
      </div>

      {mode === 'local' && !agentOnline && (
        <div style={{ padding:'10px 12px', background:`${C.red}18`, border:`1px solid ${C.red}40`, borderRadius:8, fontSize:'.72em', color:C.red, marginBottom:12 }}>
          ⚠️ Agente local no conectado. Ejecuta en tu PC:<br/>
          <code style={{ fontSize:'.9em' }}>python local_agent.py --server URL --key API_KEY</code>
        </div>
      )}

      {/* Task input */}
      <div style={{ marginBottom:10 }}>
        <textarea
          value={task}
          onChange={e => setTask(e.target.value)}
          placeholder="Describe qué quieres que AURUM haga en tu PC o navegador..."
          rows={3}
          style={{ width:'100%', padding:'10px', background:C.surf2, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, fontSize:'.78em', resize:'vertical' }}
        />
      </div>

      {mode === 'browser' && (
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="URL de inicio (opcional, ej: https://app.revolut.com)"
          style={{ width:'100%', padding:'8px 10px', background:C.surf2, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, fontSize:'.75em', marginBottom:10 }}
        />
      )}

      <button
        onClick={run}
        disabled={!task.trim() || running || (mode === 'local' && !agentOnline)}
        style={{
          width:'100%', padding:'11px', borderRadius:8,
          background: running ? C.surf3 : C.gold, color: running ? C.muted : '#000',
          border:'none', fontWeight:700, fontSize:'.8em', cursor:'pointer', marginBottom:14,
        }}
      >
        {running ? '⏳ Ejecutando…' : '▶ Ejecutar tarea'}
      </button>

      {/* Presets */}
      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:'.65em', color:C.muted, marginBottom:6 }}>ACCIONES RÁPIDAS</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
          {PRESETS.map(p => (
            <button key={p.label} onClick={() => { setTask(p.task); setUrl(p.url); setMode(p.url ? 'browser' : 'local'); }}
              style={{ padding:'8px', background:C.surf2, border:`1px solid ${C.border}`, borderRadius:7, color:C.text, fontSize:'.68em', cursor:'pointer', textAlign:'left' }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Result */}
      {result && (
        <div style={{ padding:'12px', background: result.success ? `${C.green}12` : `${C.red}12`, border:`1px solid ${result.success ? C.green : C.red}40`, borderRadius:8, marginBottom:14 }}>
          <div style={{ fontSize:'.68em', color: result.success ? C.green : C.red, fontWeight:700, marginBottom:6 }}>
            {result.success ? '✅ COMPLETADO' : '❌ ERROR'} {result.steps ? `· ${result.steps} pasos` : ''}
          </div>
          <div style={{ fontSize:'.74em', color:C.text, whiteSpace:'pre-wrap', lineHeight:1.5 }}>{result.result}</div>
          {result.screenshot_b64 && (
            <img src={`data:image/png;base64,${result.screenshot_b64}`} alt="screenshot"
              style={{ width:'100%', borderRadius:6, marginTop:10, border:`1px solid ${C.border}` }} />
          )}
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div>
          <div style={{ fontSize:'.65em', color:C.muted, marginBottom:6 }}>HISTORIAL</div>
          {history.map((h,i) => (
            <div key={i} style={{ padding:'7px 10px', background:C.surf2, border:`1px solid ${C.border}`, borderRadius:7, marginBottom:6 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:3 }}>
                <span style={{ fontSize:'.65em', color: h.ok ? C.green : C.red }}>{h.ok ? '✅' : '❌'} {h.task.slice(0,50)}</span>
                <span style={{ fontSize:'.6em', color:C.faint }}>{new Date(h.ts).toLocaleTimeString('es-ES')}</span>
              </div>
              <div style={{ fontSize:'.68em', color:C.muted }}>{h.result.slice(0,120)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   TOKEN USAGE CARD
══════════════════════════════════════════════════════════════ */
function TokenCard() {
  const [budget, setBudget] = useState<TokenBudget>(() => loadTokenBudget());

  const refresh = () => setBudget(loadTokenBudget());
  const doReset = () => { resetTokenBudget(); setBudget(loadTokenBudget()); };

  const cost   = estimateCost(budget);
  const total  = budget.inputTokens + budget.outputTokens;
  const cacheHitPct = budget.inputTokens > 0
    ? Math.round(budget.cacheReadTokens / (budget.inputTokens + budget.cacheReadTokens + budget.cacheCreationTokens) * 100)
    : 0;

  // Días en el período
  const days = Math.max(1, Math.round((Date.now() - budget.periodStart) / 86400_000));

  const fmt = (n: number) => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n);

  return (
    <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'16px 18px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
        <div>
          <div style={{ fontSize:'.78em', fontWeight:600, color:C.goldL }}>Uso de Tokens</div>
          <div style={{ fontSize:'.62em', color:C.faint, marginTop:2 }}>Últimos {days} día{days!==1?'s':''} · {budget.apiCalls} llamadas API</div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={refresh} style={{ background:'transparent', border:`1px solid ${C.border2}`, color:C.muted, borderRadius:7, padding:'3px 10px', cursor:'pointer', fontSize:'.65em', fontFamily:"'Sora',sans-serif" }}>↺</button>
          <button onClick={doReset} style={{ background:'transparent', border:`1px solid ${C.border2}`, color:C.muted, borderRadius:7, padding:'3px 10px', cursor:'pointer', fontSize:'.65em', fontFamily:"'Sora',sans-serif" }}>Reset</button>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:12 }}>
        {[
          { label:'Input',   val: fmt(budget.inputTokens),  color: C.blue,   sub: 'tokens' },
          { label:'Output',  val: fmt(budget.outputTokens), color: C.green,  sub: 'tokens' },
          { label:'Coste ~', val: `€${cost.toFixed(3)}`,    color: C.gold,   sub: 'estimado' },
        ].map(({ label, val, color, sub }) => (
          <div key={label} style={{ textAlign:'center', padding:'8px', background:C.surf3, borderRadius:8 }}>
            <div style={{ fontSize:'.98em', fontWeight:700, color, fontFamily:"'DM Mono',monospace" }}>{val}</div>
            <div style={{ fontSize:'.58em', color:C.muted }}>{label}</div>
            <div style={{ fontSize:'.54em', color:C.faint }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Cache efficiency */}
      <div style={{ marginBottom:10 }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
          <span style={{ fontSize:'.68em', color:C.muted }}>Cache hit rate</span>
          <span style={{ fontSize:'.68em', color: cacheHitPct >= 60 ? C.green : cacheHitPct >= 30 ? C.gold : C.red, fontFamily:"'DM Mono',monospace" }}>{cacheHitPct}%</span>
        </div>
        <div style={{ height:5, background:C.border, borderRadius:3, overflow:'hidden' }}>
          <div style={{ height:'100%', width:`${cacheHitPct}%`, background: cacheHitPct>=60?C.green:cacheHitPct>=30?C.gold:C.red, borderRadius:3, transition:'width .4s' }} />
        </div>
        <div style={{ fontSize:'.6em', color:C.faint, marginTop:3 }}>
          {fmt(budget.cacheReadTokens)} leídos de caché · {fmt(budget.cacheCreationTokens)} escritos · {budget.webSearchCalls} búsquedas web
        </div>
      </div>

      {/* Tip */}
      <div style={{ fontSize:'.62em', color:C.faint, lineHeight:1.5, fontStyle:'italic' }}>
        {cacheHitPct >= 70
          ? '✓ Excelente eficiencia. El system prompt se está cacheando correctamente.'
          : cacheHitPct >= 40
          ? '◑ Caché moderada. Cada conversación larga mejora la eficiencia.'
          : '▲ Caché baja — normal en el primer uso. Mejora con el uso continuado.'}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   VERSION CARD + OTA CHECKER
══════════════════════════════════════════════════════════════ */
interface LatestJson {
  version: string;
  build: string;
  apkUrl: string;
  changelog: string[];
}

function VersionCard() {
  const [latest,   setLatest]   = useState<LatestJson | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked,  setChecked]  = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      // Intenta /latest.json desde Cloudflare Pages o local
      const urls = ['/latest.json', 'https://aurum-7cm.pages.dev/latest.json'];
      for (const url of urls) {
        try {
          const res = await fetch(url + '?t=' + Date.now());
          if (res.ok) { setLatest(await res.json()); break; }
        } catch { /* silencioso */ }
      }
    } finally { setChecking(false); setChecked(true); }
  };

  useEffect(() => { check(); }, []);

  const hasUpdate = latest && latest.version !== APP_VERSION;

  return (
    <div style={{ borderTop:`1px solid ${C.border}`, marginTop:8, paddingTop:16 }}>
      {/* Update banner */}
      {hasUpdate && (
        <div style={{ marginBottom:14, padding:'14px 16px', background:`${C.green}0d`, border:`1px solid ${C.green}44`, borderRadius:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <div style={{ fontSize:'.78em', fontWeight:600, color:C.green }}>🚀 Nueva versión disponible: v{latest!.version}</div>
            <a href={latest!.apkUrl} target="_blank" rel="noreferrer"
              style={{ background:C.green, color:'#07070e', fontSize:'.7em', fontWeight:700, padding:'6px 14px', borderRadius:8, textDecoration:'none', fontFamily:"'Sora',sans-serif", flexShrink:0 }}>
              ⬇ Descargar APK
            </a>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
            {latest!.changelog.map((c, i) => (
              <div key={i} style={{ fontSize:'.68em', color:C.muted, display:'flex', gap:6 }}>
                <span style={{ color:C.green, flexShrink:0 }}>◆</span>{c}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Version info */}
      <div style={{ textAlign:'center', padding:'4px 0 8px' }}>
        <div style={{ fontSize:'.72em', fontWeight:600, color:C.gold, fontFamily:"'DM Mono',monospace", letterSpacing:'.5px' }}>
          AURUM Nexus v{APP_VERSION}
        </div>
        <div style={{ fontSize:'.62em', color:C.faint, marginTop:3, fontFamily:"'DM Mono',monospace" }}>
          build {APP_BUILD} · com.aurum.advisor
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:10, marginTop:8 }}>
          {checked && !hasUpdate && (
            <span style={{ fontSize:'.62em', color:C.green }}>✓ Tienes la última versión</span>
          )}
          <button onClick={check} disabled={checking}
            style={{ background:'transparent', border:`1px solid ${C.border2}`, borderRadius:7, padding:'4px 12px', color:checking?C.faint:C.muted, cursor:'pointer', fontSize:'.62em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', gap:5 }}>
            {checking ? <><Spinner/>Comprobando…</> : '↻ Buscar actualización'}
          </button>
        </div>
        {/* Link de descarga directa siempre disponible */}
        {latest?.apkUrl && (
          <div style={{ marginTop:10, fontSize:'.62em', color:C.faint }}>
            <a href={latest.apkUrl} target="_blank" rel="noreferrer"
              style={{ color:C.blue, textDecoration:'none' }}>
              ⬇ Descarga directa APK (Drive)
            </a>
            <span style={{ margin:'0 6px', color:C.border2 }}>·</span>
            <span style={{ color:C.faint }}>Powered by Claude Sonnet · GPT-4o · DeepSeek R1</span>
          </div>
        )}
      </div>
    </div>
  );
}


/* ── Cuenta y sesión ──────────────────────────────────────────────────────── */

/**
 * Bloque de cuenta dentro de Ajustes: quién ha iniciado sesión, cierre de
 * sesión y, si el usuario es el propietario, emisión de invitaciones.
 *
 * El código de invitación solo se muestra en el momento de crearlo: el servidor
 * guarda únicamente su hash y no puede volver a enseñarlo.
 */
/**
 * Descarga de la aplicación para Android.
 *
 * Se enseña solo en la web: dentro de la propia aplicación no tiene sentido
 * ofrecer instalarla. Y no aparece en cada cambio porque no hace falta — la
 * APK es una carcasa que carga este mismo sitio, así que lo de la web llega
 * solo al recargar. Solo se reparte una nueva cuando cambia algo nativo.
 */
/**
 * Avisa cuando hay una versión de la aplicación más nueva que la instalada.
 *
 * Solo en el móvil, y solo cuando de verdad hay una: la APK es una carcasa que
 * abre este mismo sitio, así que los cambios de la web llegan al recargar y no
 * justifican molestar a nadie. Aparece cuando cambia algo nativo.
 */
function AvisoActualizacion() {
  const [nueva, setNueva] = useState<{ versionName:string; url:string }|null>(null);
  const [abriendo, setAbriendo] = useState(false);
  const [fallo,    setFallo]    = useState<string|null>(null);

  useEffect(() => {
    if (!isNative) return;
    let vigente = true;

    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const instalada = Number((await App.getInfo()).build);
        const { publicada } = await apiFetch<{ publicada: { versionCode:number; versionName:string; url:string } | null }>(
          '/api/apk-actualizacion',
        );
        // Sin versión publicada, o con una que no es más nueva, no hay nada
        // que decir. Un aviso que sale siempre deja de leerse.
        if (!vigente || !publicada || !Number.isFinite(instalada)) return;
        if (publicada.versionCode <= instalada) return;
        setNueva({ versionName: publicada.versionName, url: publicada.url });
      } catch {
        // Comprobar actualizaciones no es motivo para romper el arranque.
      }
    })();

    return () => { vigente = false; };
  }, []);

  if (!nueva) return null;

  const instalar = async () => {
    setAbriendo(true);
    setFallo(null);
    const enlace = `${API_BASE}${nueva.url}`;

    // La aplicación descarga y llama al instalador de Android. La confirmación
    // final la sigue pidiendo el sistema —eso no se salta, y está bien que sea
    // así— pero descargar en Chrome y buscar el fichero a mano sobra.
    const plugin = (window as unknown as {
      Capacitor?: { Plugins?: { Instalador?: { instalar: (o:{url:string}) => Promise<unknown> } } };
    }).Capacitor?.Plugins?.Instalador;

    if (plugin) {
      try {
        await plugin.instalar({ url: enlace });
        setNueva(null);
        return;
      } catch (e: any) {
        // Falta el permiso de instalar, o la descarga no ha ido. El plugin ya
        // ha abierto los ajustes si era lo primero; aquí se dice el motivo.
        setFallo(String(e?.message ?? e));
        setAbriendo(false);
        return;
      }
    }

    // Versiones anteriores al instalador propio: por el navegador, como antes.
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url: enlace });
      setNueva(null);
    } catch {
      setAbriendo(false);
    }
  };

  return (
    <div style={{
      background:`${C.gold}14`, borderBottom:`1px solid ${C.gold}44`,
      padding:'9px 16px', display:'flex', alignItems:'center', justifyContent:'space-between',
      gap:12, flexShrink:0, zIndex:11, position:'relative',
    }}>
      <span style={{ fontSize:'.72em', color:C.text, lineHeight:1.4 }}>
        Hay una versión nueva de la aplicación ({nueva.versionName}).
        {fallo && <span style={{ display:'block', color:C.red, fontSize:'.92em' }}>{fallo}</span>}
      </span>
      <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
        <button onClick={instalar} disabled={abriendo}
          style={{ background:C.gold, border:'none', borderRadius:7, padding:'5px 12px', color:'#07070e', fontWeight:600, cursor: abriendo ? 'default' : 'pointer', fontSize:'.72em', fontFamily:"'Sora',sans-serif", whiteSpace:'nowrap' }}>
          {abriendo ? 'Descargando…' : 'Instalar'}
        </button>
        <button onClick={() => setNueva(null)}
          style={{ background:'transparent', border:'none', color:C.muted, cursor:'pointer', fontSize:'.9em', padding:'0 4px' }}>
          ✕
        </button>
      </div>
    </div>
  );
}

function AplicacionAndroidSection() {
  const [bajando, setBajando] = useState(false);
  const [error,   setError]   = useState<string|null>(null);

  if (isNative) return null;

  const descargar = async () => {
    setBajando(true); setError(null);
    try {
      // Va por la API porque la descarga exige sesión: el fichero no está
      // colgado en ninguna dirección pública.
      const res = await apiFetchRaw('/api/apk');
      if (!res.ok) {
        setError(res.status === 404
          ? 'Todavía no hay ninguna versión publicada.'
          : 'No se ha podido descargar.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'aurum.apk';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('No se ha podido descargar.');
    } finally {
      setBajando(false);
    }
  };

  return (
    <div>
      <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.18em', fontWeight:600, color:C.goldL, marginBottom:4 }}>
        AURUM en el móvil
      </div>
      <div style={{ fontSize:'.74em', color:C.muted, marginBottom:14, lineHeight:1.5 }}>
        La aplicación de Android es una carcasa que abre este mismo sitio, así que
        lo que cambia en la web te llega sola al recargar. Solo hace falta volver a
        instalarla cuando cambia algo del propio móvil — como compartir capturas
        con AURUM.
      </div>
      <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'16px 20px', display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
        <button onClick={descargar} disabled={bajando}
          style={{ background: bajando ? `${C.gold}44` : C.gold, border:'none', borderRadius:9, padding:'9px 18px', color:'#07070e', fontWeight:600, cursor: bajando ? 'default' : 'pointer', fontSize:'.78em', fontFamily:"'Sora',sans-serif" }}>
          {bajando ? 'Descargando…' : '⬇ Descargar la APK'}
        </button>
        <span style={{ fontSize:'.68em', color:C.muted, lineHeight:1.5 }}>
          Ábrela en el móvil para instalarla encima de la que tengas.
          {error && <span style={{ color:C.red, display:'block' }}>{error}</span>}
        </span>
      </div>
    </div>
  );
}

function AccountSection() {
  const { user, offline, signOut } = useSession();
  const [inviteEmail, setInviteEmail] = useState('');
  const [issued, setIssued]           = useState<{ code:string; email:string|null }|null>(null);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string|null>(null);

  const issue = async () => {
    setBusy(true); setError(null);
    try {
      const res = await createInvite(inviteEmail.trim() ? { email: inviteEmail.trim() } : {});
      setIssued({ code: res.code, email: res.email });
      setInviteEmail('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se ha podido crear la invitación.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.18em', fontWeight:600, color:C.goldL, marginBottom:4 }}>Cuenta</div>
      <div style={{ fontSize:'.74em', color:C.muted, marginBottom:14 }}>Tus datos se guardan en tu cuenta, no en este dispositivo.</div>

      <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'14px 16px', display:'flex', flexDirection:'column', gap:12 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
          <div>
            <div style={{ fontSize:'.84em', color:C.text }}>{user.name || user.email}</div>
            <div style={{ fontSize:'.7em', color:C.muted }}>
              {user.email} · {user.role === 'owner' ? 'Propietario' : 'Usuario'}
            </div>
          </div>
          <button onClick={() => void signOut()} style={{ background:C.surf3, border:`1px solid ${C.border2}`, borderRadius:9, padding:'8px 14px', color:C.text, fontSize:'.76em', fontFamily:"'Sora',sans-serif", cursor:'pointer' }}>
            Cerrar sesión
          </button>
        </div>

        {offline && (
          <div style={{ background:`${C.blue}12`, border:`1px solid ${C.blue}33`, borderRadius:9, padding:'9px 11px', fontSize:'.72em', color:C.text }}>
            Sin conexión con el servidor: estás viendo la copia local. Los cambios se enviarán al recuperar la conexión.
          </div>
        )}

        {user.role === 'owner' && (
          <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:12 }}>
            <div style={{ fontSize:'.76em', color:C.text, marginBottom:6 }}>Invitar a alguien</div>
            <div style={{ fontSize:'.68em', color:C.muted, marginBottom:9, lineHeight:1.45 }}>
              El registro está cerrado. Con un correo, la invitación solo sirve para esa persona.
            </div>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              <input
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                placeholder="correo@ejemplo.com (opcional)"
                style={{ ...inputBase, flex:'1 1 200px', width:'auto' }}
              />
              <button onClick={() => void issue()} disabled={busy} style={{ background:busy?C.surf3:C.gold, color:busy?C.muted:C.bg, border:'none', borderRadius:9, padding:'8px 16px', fontSize:'.78em', fontWeight:600, fontFamily:"'Sora',sans-serif", cursor:busy?'default':'pointer' }}>
                {busy ? 'Creando…' : 'Crear invitación'}
              </button>
            </div>

            {error && <div style={{ marginTop:9, fontSize:'.72em', color:C.red }}>{error}</div>}

            {issued && (
              <div style={{ marginTop:11, background:C.surf3, border:`1px solid ${C.gold}44`, borderRadius:9, padding:'11px 13px' }}>
                <div style={{ fontSize:'.68em', color:C.muted, marginBottom:5 }}>
                  Cópialo ahora: no se puede volver a mostrar.
                </div>
                <div style={{ fontFamily:'monospace', fontSize:'.9em', color:C.goldL, letterSpacing:'.06em', wordBreak:'break-all' }}>
                  {issued.code}
                </div>
                {issued.email && <div style={{ fontSize:'.68em', color:C.muted, marginTop:5 }}>Válida solo para {issued.email}</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Claves de IA ─────────────────────────────────────────────────────────── */

/**
 * Claves de proveedor que aporta el usuario.
 *
 * Una clave guardada no se puede recuperar: el servidor solo devuelve una pista
 * con los ultimos caracteres. El campo se deja vacio tras guardar para que
 * quede claro que lo que hay escrito no es lo que esta almacenado.
 *
 * Con clave propia el usuario elige el modelo, porque paga el. Con la clave del
 * proyecto los modelos van restringidos por allowlist.
 */
function ProviderKeysSection() {
  const [providers, setProviders] = useState<ProviderKeyStatus[]>([]);
  const [borrador, setBorrador]   = useState<Record<string, { key:string; model:string }>>({});
  const [catalogos, setCatalogos] = useState<Record<string, CatalogoModelos|undefined>>({});
  const [ocupado, setOcupado]     = useState<string|null>(null);
  const [error, setError]         = useState<string|null>(null);
  const [aviso, setAviso]         = useState<string|null>(null);

  const recargar = () => { fetchProviderKeys().then(setProviders).catch(() => setError('No se ha podido leer la configuracion de claves.')); };
  useEffect(recargar, []);

  const campo = (id:string) => borrador[id] ?? { key:'', model:'' };

  /** El catalogo se pide al abrir el desplegable, no al cargar la pantalla:
   *  son seis llamadas a proveedores externos que casi nunca hacen falta. */
  const cargarCatalogo = (id:string) => {
    if (catalogos[id] !== undefined) return;
    fetchModelos(id)
      .then(c => setCatalogos(prev => ({ ...prev, [id]: c })))
      .catch(() => setError(`No se ha podido leer el catálogo de modelos. Comprueba que la clave sea válida.`));
  };

  /** true si el modelo guardado ya no aparece en el catálogo del proveedor. */
  const caducado = (p:ProviderKeyStatus) => {
    const cat = catalogos[p.id];
    if (!cat || !p.model || p.model === MODELO_AUTOMATICO) return false;
    return !cat.models.some(m => m.id === p.model);
  };
  const editar = (id:string, parche:Partial<{key:string;model:string}>) =>
    setBorrador(b => ({ ...b, [id]: { ...campo(id), ...parche } }));

  const guardar = async (id:string) => {
    const { key, model } = campo(id);
    // Con la clave ya guardada basta con el modelo: no se puede releer, asi que
    // pedirla otra vez para un cambio trivial seria ir a buscarla al proveedor.
    if (!key.trim() && !model.trim()) { setError('Escribe la clave o el modelo antes de guardar.'); return; }
    setOcupado(id); setError(null); setAviso(null);
    try {
      await saveProviderKey(id, key.trim(), model);
      // Aviso util: sin modelo, estos proveedores no llegan a usarse.
      const p = providers.find(x => x.id === id);
      const sinModelo = !model.trim() && !p?.model && !p?.restricted;
      setBorrador(b => ({ ...b, [id]: { key:'', model:'' } }));
      setAviso(sinModelo
        ? 'Guardado. Falta indicar el modelo: sin el, este proveedor no se usa.'
        : 'Guardado.');
      recargar();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se ha podido guardar la clave.');
    } finally { setOcupado(null); }
  };

  const borrar = async (id:string) => {
    setOcupado(id); setError(null); setAviso(null);
    try { await deleteProviderKey(id); setAviso('Clave eliminada.'); recargar(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'No se ha podido borrar la clave.'); }
    finally { setOcupado(null); }
  };

  return (
    <div>
      <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.18em', fontWeight:600, color:C.goldL, marginBottom:4 }}>Claves de IA</div>
      <div style={{ fontSize:'.74em', color:C.muted, marginBottom:14, lineHeight:1.5 }}>
        Puedes usar tus propias claves. Se guardan cifradas y no se pueden volver a leer:
        solo veras los ultimos caracteres. Con clave propia eliges tu el modelo.
      </div>

      {error && <div style={{ marginBottom:10, fontSize:'.74em', color:C.red }}>{error}</div>}
      {aviso && <div style={{ marginBottom:10, fontSize:'.74em', color:C.green }}>{aviso}</div>}

      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {providers.map(p => (
          <div key={p.id} style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:11, padding:'12px 14px' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8, marginBottom:9 }}>
              <span style={{ fontSize:'.84em', color:C.text }}>{p.label}</span>
              <span style={{ fontSize:'.68em', color: p.hasOwnKey ? C.green : p.hasProjectKey ? C.muted : C.red }}>
                {p.hasOwnKey ? `tu clave ${p.hint}` : p.hasProjectKey ? 'clave del proyecto' : 'sin configurar'}
              </span>
            </div>

            {p.hasOwnKey && p.model && (
              <div style={{ fontSize:'.68em', color:C.muted, marginBottom:8 }}>
                Modelo: {p.model === MODELO_AUTOMATICO ? 'Auto — el más barato' : p.model}
                {/* Un modelo retirado por el proveedor falla en el momento de
                    usarlo; avisar aqui evita descubrirlo a mitad de una consulta. */}
                {caducado(p) && (
                  <span style={{ color:C.red }}> · ya no está en el catálogo</span>
                )}
              </div>
            )}

            <div style={{ display:'flex', gap:7, flexWrap:'wrap' }}>
              {/* La clave guardada no se puede volver a leer: ni el servidor la
                  devuelve, que es lo que impide sacarla desde la consola del
                  navegador. Pero un campo en blanco se lee como «no se guardo»,
                  asi que el hueco lo ocupa la pista — puntos y los cuatro
                  ultimos caracteres — y el borde se marca cuando hay una. */}
              <input
                type="password"
                value={campo(p.id).key}
                onChange={e => editar(p.id, { key:e.target.value })}
                placeholder={p.hasOwnKey ? `${p.hint}  ·  escribe para reemplazar` : 'Clave de API'}
                autoComplete="off"
                style={{
                  ...inputBase, flex:'2 1 190px', width:'auto',
                  ...(p.hasOwnKey && !campo(p.id).key
                    ? { borderColor:`${C.green}55`, background:`${C.green}0c` }
                    : {}),
                }}
              />
              <select
                value={campo(p.id).model || p.model || ''}
                onChange={e => editar(p.id, { model:e.target.value })}
                onFocus={() => cargarCatalogo(p.id)}
                style={{ ...inputBase, flex:'1 1 170px', width:'auto', cursor:'pointer' }}
              >
                <option value="">{catalogos[p.id] ? 'Elige modelo…' : 'Toca para cargar modelos…'}</option>
                {catalogos[p.id]?.autoDisponible && (
                  <option value={MODELO_AUTOMATICO}>
                    Auto — el más barato{catalogos[p.id]?.auto ? ` (ahora: ${catalogos[p.id]!.auto!.id})` : ''}
                  </option>
                )}
                {catalogos[p.id]?.models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.gratuito ? '· gratis · ' : m.salida !== null ? `· ${m.salida.toFixed(2)} $/M · ` : '· '}{m.id}
                  </option>
                ))}
              </select>
              <button onClick={() => void guardar(p.id)} disabled={ocupado===p.id}
                style={{ background:ocupado===p.id?C.surf3:C.gold, color:ocupado===p.id?C.muted:C.bg, border:'none', borderRadius:9, padding:'8px 14px', fontSize:'.76em', fontWeight:600, fontFamily:"'Sora',sans-serif", cursor:ocupado===p.id?'default':'pointer' }}>
                Guardar
              </button>
              {p.hasOwnKey && (
                <button onClick={() => void borrar(p.id)} disabled={ocupado===p.id}
                  style={{ background:'transparent', border:`1px solid ${C.border2}`, borderRadius:9, padding:'8px 12px', color:C.muted, fontSize:'.76em', fontFamily:"'Sora',sans-serif", cursor:'pointer' }}>
                  Quitar
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsTab({ profile, setProfile, userProfile, setUserProfile }:{
  profile: string;
  setProfile: (p:string)=>void;
  userProfile: UserProfile;
  setUserProfile: (p:UserProfile)=>void;
}) {
  const [saved, setSaved] = useState(false);
  const fieldStyle:React.CSSProperties = { ...inputBase, padding:'8px 12px' };

  const save = async () => {
    await sSet('aurum-user-profile', userProfile);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const fields:[keyof UserProfile, string, string, string][] = [
    ['name',    'Nombre',                    'Ej: Carlos',            'text'],
    ['age',     'Edad',                      'Ej: 35',                'number'],
    ['capital', 'Capital disponible (€)',    'Ej: 25000',             'number'],
    ['income',  'Ingresos anuales brutos (€)','Ej: 45000',            'number'],
    ['horizon', 'Horizonte temporal',        'Ej: 10-15 años',        'text'],
    ['broker',  'Broker principal',          'Ej: DEGIRO, MyInvestor','text'],
    ['country', 'País de residencia fiscal', 'España',                'text'],
  ];

  return (
    <div style={{ height:'100%', overflow:'auto', padding:'24px 28px' }}>
      <div style={{ maxWidth:700, margin:'0 auto', display:'flex', flexDirection:'column', gap:24 }}>

        <AccountSection />

        <AplicacionAndroidSection />

        <ProviderKeysSection />

        {/* Perfil de riesgo */}
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.18em', fontWeight:600, color:C.goldL, marginBottom:4 }}>Perfil de Inversión</div>
          <div style={{ fontSize:'.74em', color:C.muted, marginBottom:14 }}>Determina la estrategia de asignación y el tono del asesor.</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
            {Object.entries(PROFILES).map(([key, pf]) => {
              const active = profile === key;
              return (
                <button key={key} onClick={() => setProfile(key)} style={{ background:active?`${pf.color}18`:C.surf2, border:`1px solid ${active?pf.color+'55':C.border}`, borderRadius:13, padding:'16px 14px', cursor:'pointer', textAlign:'left', transition:'all .2s' }}>
                  <div style={{ fontSize:'1.5em', marginBottom:8 }}>{pf.emoji}</div>
                  <div style={{ fontSize:'.84em', fontWeight:600, color:active?pf.color:C.text, marginBottom:4 }}>{pf.label}</div>
                  <div style={{ fontSize:'.68em', color:C.muted, lineHeight:1.4 }}>{pf.alloc}</div>
                  {active && <div style={{ marginTop:8, fontSize:'.62em', color:pf.color, borderTop:`1px solid ${pf.color}33`, paddingTop:6, lineHeight:1.4 }}>{pf.sys.slice(0,80)}…</div>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Datos personales */}
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.18em', fontWeight:600, color:C.goldL, marginBottom:4 }}>Datos Personales</div>
          <div style={{ fontSize:'.74em', color:C.muted, marginBottom:14 }}>La IA usa esta información para personalizar todas sus respuestas.</div>
          <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'18px 20px', display:'flex', flexDirection:'column', gap:14 }}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {fields.map(([key, label, placeholder, type]) => (
                <div key={key}>
                  <div style={{ fontSize:'.65em', color:C.muted, marginBottom:5, letterSpacing:'.5px' }}>{label}</div>
                  <input
                    type={type}
                    value={userProfile[key]}
                    onChange={e => setUserProfile({ ...userProfile, [key]: e.target.value })}
                    placeholder={placeholder}
                    style={fieldStyle}
                  />
                </div>
              ))}
            </div>
            <div>
              {/* Se llamaba «Notas adicionales para la IA», que no le dice a
                  nadie que aquí es donde van sus planes. Y es lo que más
                  cambia los consejos: sin esto los agentes solo ven números. */}
              <div style={{ fontSize:'.65em', color:C.muted, marginBottom:5, letterSpacing:'.5px' }}>
                Tus planes y tu situación
              </div>
              <div style={{ fontSize:'.62em', color:C.faint, marginBottom:7, lineHeight:1.5 }}>
                Cuéntale a AURUM qué quieres hacer con tu dinero y qué te condiciona. Es lo
                que más cambia sus consejos: sin esto solo ve números.
              </div>
              <textarea
                value={userProfile.notes}
                onChange={e => setUserProfile({ ...userProfile, notes: e.target.value })}
                placeholder={'Ej: Quiero comprar piso en 3 o 4 años y necesito tener 40.000 € líquidos para la entrada.\n'
                  + 'Aporto 300 €/mes y no quiero tocar lo que ya tengo invertido.\n'
                  + 'Prefiero ETFs de acumulación. Tengo pérdidas fiscales pendientes de compensar.'}
                rows={5}
                style={{ ...fieldStyle, resize:'vertical', lineHeight:1.55 }}
              />
            </div>
            <button onClick={save}
              style={{ alignSelf:'flex-start', background:saved?C.green:C.gold, border:'none', borderRadius:9, padding:'9px 22px', color:'#07070e', fontWeight:600, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif", transition:'all .2s', display:'flex', alignItems:'center', gap:7 }}>
              {saved ? '✓ Guardado' : '💾 Guardar datos'}
            </button>
          </div>
        </div>

        {/* Nexus Routing */}
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.18em', fontWeight:600, color:C.goldL, marginBottom:4 }}>Nexus Routing</div>
          <div style={{ fontSize:'.74em', color:C.muted, marginBottom:14 }}>Cada agente usa el modelo óptimo para su tarea.</div>
          <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, overflow:'hidden' }}>
            {([
              ['◈ AURUM',  'Asesor general',      'anthropic', 'claude-sonnet-5',      'Mejor calidad conversacional + búsqueda web'],
              ['🌐 MACRO', 'Análisis macro',       'openai',    'gpt-4o-search-preview',  'Datos macroeconómicos en tiempo real'],
              ['⚖️ RIESGO','Gestión de riesgos',   'deepseek',  'deepseek-reasoner (R1)', 'Razonamiento matemático profundo (VaR, Sharpe)'],
              ['🧾 FISCAL','Asesoría fiscal',       'anthropic', 'claude-sonnet-5',      'Interpretación de normativa fiscal española'],
            ] as [string,string,string,string,string][]).map(([agent, role, prov, model, desc]) => {
              const pm = PROVIDER_META[prov as keyof typeof PROVIDER_META];
              return (
                <div key={agent} style={{ display:'grid', gridTemplateColumns:'100px 130px 1fr', gap:12, padding:'12px 18px', borderBottom:`1px solid ${C.border}22`, alignItems:'center' }}>
                  <div style={{ fontSize:'.84em', fontWeight:600, color:C.text }}>{agent}</div>
                  <div>
                    <div style={{ fontSize:'.72em', color:pm.color, fontFamily:"'DM Mono',monospace" }}>{model}</div>
                    <div style={{ fontSize:'.62em', color:C.muted, marginTop:2 }}>{role}</div>
                  </div>
                  <div style={{ fontSize:'.68em', color:C.faint, lineHeight:1.4 }}>{desc}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Backend Proxmox */}
        <BackendSection />

        {/* Monitorización autónoma */}
        <AutonomousSection profile={profile} />

        {/* Token usage */}
        <TokenCard />

        {/* Versión + OTA checker */}
        <VersionCard />

      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   BOTTOM NAV
══════════════════════════════════════════════════════════════ */
function BottomNav({ tab, setTab, alertCount, onAlertOpen }: {
  tab: string; setTab: (t:string)=>void;
  alertCount: number; onAlertOpen: ()=>void;
}) {
  const BNAV = [
    { id:'chat',      icon:'💬', label:'Chat',     shortcut:'Ctrl+1' },
    { id:'portfolio', icon:'📊', label:'Cartera',  shortcut:'Ctrl+2' },
    { id:'invest',    icon:'💰', label:'Invertir', shortcut:'Ctrl+3' },
    { id:'research',  icon:'🔬', label:'Research', shortcut:'Ctrl+4' },
    { id:'control',   icon:'🖥️', label:'Control',  shortcut:'Ctrl+5' },
    { id:'settings',  icon:'⚙️', label:'Ajustes',  shortcut:'Ctrl+6' },
  ];
  return (
    <nav style={{
      position:'fixed', bottom:0, left:0, right:0, zIndex:100,
      background:'rgba(9,9,20,0.97)', backdropFilter:'blur(20px)',
      borderTop:`1px solid #1e1e30`,
      display:'flex', alignItems:'stretch',
      paddingBottom:'env(safe-area-inset-bottom, 0px)',
      height:'calc(58px + env(safe-area-inset-bottom, 0px))',
    }}>
      {BNAV.map(n => (
        <button key={n.id} className={`bnav-btn${tab===n.id?' active':''}`}
          onClick={() => setTab(n.id)}
          title={n.shortcut}
          style={{
            flex:1, background:'transparent', border:'none', cursor:'pointer',
            display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
            gap:3, color: tab===n.id ? C.gold : C.muted, transition:'all .18s',
            padding:'6px 0 2px', position:'relative',
          }}>
          <span className="bnav-icon" style={{ fontSize:'1.35em', lineHeight:1, transition:'transform .18s', display:'block' }}>{n.icon}</span>
          <span style={{ fontSize:'.58em', fontWeight: tab===n.id ? 600 : 400, letterSpacing:'.04em', fontFamily:"'Sora',sans-serif" }}>{n.label}</span>
          {tab===n.id && <div style={{ position:'absolute', bottom:0, width:24, height:2, background:C.gold, borderRadius:'2px 2px 0 0' }} />}
        </button>
      ))}
      {/* Botón de alertas */}
      <button onClick={onAlertOpen} style={{
        width:46, background:'transparent', border:'none', cursor:'pointer',
        display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
        gap:3, color: alertCount > 0 ? '#e8734a' : C.muted, transition:'all .18s',
        padding:'6px 0 2px', position:'relative', borderLeft:`1px solid ${C.border}`,
      }}>
        <span style={{ fontSize:'1.2em', lineHeight:1 }}>🔔</span>
        <span style={{ fontSize:'.52em', letterSpacing:'.04em', fontFamily:"'Sora',sans-serif" }}>Alertas</span>
        {alertCount > 0 && (
          <div style={{ position:'absolute', top:6, right:8, width:16, height:16, borderRadius:'50%', background:'#e8734a', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'.5em', color:'#fff', fontWeight:700, lineHeight:1 }}>
            {alertCount > 9 ? '9+' : alertCount}
          </div>
        )}
      </button>
    </nav>
  );
}

/* ══════════════════════════════════════════════════════════════
   ROOT APP
══════════════════════════════════════════════════════════════ */
export default function App() {
  const [tab,          setTab]         = useState('chat');
  const [profile,      setProfile]     = useState('moderado');
  const [portfolio,    setPortfolio]   = useState<Position[]>([]);
  const [userProfile,  setUserProfile] = useState<UserProfile>(EMPTY_PROFILE);
  const [alertCount,   setAlertCount]  = useState(0);
  const [showAlerts,   setShowAlerts]  = useState(false);

  const portfolioRef    = useRef<Position[]>([]);
  const profileRef      = useRef<string>('moderado');
  const userProfileRef  = useRef<UserProfile>(EMPTY_PROFILE);
  const backendCfgRef   = useRef<{url:string;apiKey:string}|null>(null);

  // El oyente del botón atrás se registra una sola vez, así que no puede leer
  // el estado por cierre: lo vería congelado en el del primer render.
  const tabRef        = useRef<string>('chat');
  const showAlertsRef = useRef<boolean>(false);
  tabRef.current        = tab;
  showAlertsRef.current = showAlerts;

  portfolioRef.current   = portfolio;
  profileRef.current     = profile;
  userProfileRef.current = userProfile;

  // Una captura compartida desde otra aplicación entra por aquí: se recoge del
  // sistema, se lleva al usuario a Cartera y allí se abre el importador. Se
  // mira también al recibir el aviso, porque compartir con AURUM ya abierto no
  // vuelve a pasar por el arranque.
  useEffect(() => {
    const mirar = async () => {
      const { captura, fallo } = await compartido.recogerDelSistema();
      if (!captura && !fallo) return;
      if (captura) compartido.dejar(captura);
      else if (fallo) compartido.dejarFallo(fallo);
      setTab('portfolio');
      window.dispatchEvent(new Event(compartido.EVENTO_CAPTURA));
    };
    void mirar();
    window.addEventListener('aurumCapturaCompartida', mirar);
    return () => window.removeEventListener('aurumCapturaCompartida', mirar);
  }, []);

  // El botón atrás del móvil, por orden: primero cierra lo que haya abierto,
  // después vuelve a la pestaña principal, y solo entonces sale. Sin esto no
  // hacía nada —la aplicación no tiene historial de navegación— y no había
  // forma de salir salvo matándola.
  useEffect(() => {
    if (!isNative) return;
    let quitar: (() => void) | null = null;

    (async () => {
      const { App } = await import('@capacitor/app');
      const oyente = await App.addListener('backButton', () => {
        if (showAlertsRef.current) { setShowAlerts(false); return; }
        if (atras.atender()) return;
        if (tabRef.current !== 'chat') { setTab('chat'); return; }
        void App.exitApp();
      });
      quitar = () => { void oyente.remove(); };
    })();

    return () => { quitar?.(); };
  }, []);

  // Atajos de teclado globales
  useEffect(() => {
    const TAB_KEYS: Record<string, string> = { '1':'chat', '2':'portfolio', '3':'invest', '4':'control', '5':'settings' };
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && TAB_KEYS[e.key]) { e.preventDefault(); setTab(TAB_KEYS[e.key]); }
      if (e.key === 'Escape') setShowAlerts(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    bootstrap();
    initNexus();
    sGet('aurum-portfolio').then((p:Position[]|null) => { if (p) setPortfolio(p); });
    sGet('aurum-user-profile').then((p:UserProfile|null) => { if (p) setUserProfile(p); });
    sGet('aurum-profile').then((p:string|null) => { if (p) setProfile(p); });
    sGet('aurum-backend-config').then((c:any) => { if (c?.url) backendCfgRef.current = c; });

    setAlertCount(unreadCount());

    // Monitor de alertas (drift, riesgo, pérdidas)
    startMonitor(
      () => portfolioRef.current,
      () => profileRef.current,
      (count) => setAlertCount(count),
    );

    // Scheduler de decisiones autónomas (invest/rebalance/hold)
    startDecisionScheduler(
      () => portfolioRef.current,
      () => profileRef.current,
      () => userProfileRef.current,
      () => backendCfgRef.current,
      (decision: Decision, executed: boolean) => {
        addAlert({
          type:       'recommendation_update',
          severity:   executed ? 'info' : 'warning',
          title:      executed
            ? `AURUM ejecutó autónomamente: ${decision.trades.map(t=>t.ticker).join(', ')}`
            : `AURUM propone: ${decision.type} — ${decision.trades.map(t=>t.ticker).join(', ')||'mantener'}`,
          body:       decision.reasoning,
          actionable: !executed,
          action:     executed ? undefined : 'Ver en Invertir',
          actionTab:  'invest',
        });
        setAlertCount(unreadCount());
      },
    );

    return () => { stopMonitor(); stopDecisionScheduler(); };
  }, []);

  const pf = PROFILES[profile];

  const handleSetProfile = (p: string) => {
    setProfile(p);
    sSet('aurum-profile', p);
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', width:'100%', background:C.bg, fontFamily:"'Sora',sans-serif", color:C.text, overflow:'hidden', position:'relative' }}>
      {/* Ambient orbs */}
      <div style={{ position:'fixed', top:-120, left:-80, width:380, height:380, borderRadius:'50%', background:`radial-gradient(circle,${C.gold}09 0%,transparent 70%)`, animation:'orb-float 7s ease-in-out infinite', pointerEvents:'none', zIndex:0 }}/>
      <div style={{ position:'fixed', bottom:-80, right:250, width:300, height:300, borderRadius:'50%', background:`radial-gradient(circle,${C.blue}07 0%,transparent 70%)`, animation:'orb-float 9s ease-in-out 3s infinite', pointerEvents:'none', zIndex:0 }}/>
      <div style={{ position:'fixed', inset:0, backgroundImage:`linear-gradient(${C.gold}035 1px,transparent 1px),linear-gradient(90deg,${C.gold}035 1px,transparent 1px)`, backgroundSize:'44px 44px', pointerEvents:'none', zIndex:0 }}/>

      <AvisoActualizacion />

      {/* Header compacto mobile */}
      <header style={{
        background:'rgba(9,9,20,0.97)', backdropFilter:'blur(16px)',
        borderBottom:`1px solid ${C.border}`,
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:`calc(10px + env(safe-area-inset-top, 0px)) 16px 10px`,
        flexShrink:0, zIndex:10, position:'relative',
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:9, background:`linear-gradient(135deg,${C.goldD},${C.goldL})`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:15, fontWeight:800, color:'#07070e', fontFamily:"'Cormorant Garamond',serif", boxShadow:`0 0 16px ${C.gold}40`, flexShrink:0 }}>A</div>
          <div>
            <div style={{ fontSize:'.82em', fontWeight:600, color:C.text, lineHeight:1.2 }}>AURUM <span style={{ color:C.gold, fontFamily:"'Cormorant Garamond',serif", fontStyle:'italic', fontWeight:400 }}>Nexus</span> <span style={{ fontSize:'.65em', color:C.faint, fontFamily:"'DM Mono',monospace", fontWeight:400 }}>v{APP_VERSION}</span></div>
            <div style={{ fontSize:'.56em', color:C.faint, display:'flex', gap:5, alignItems:'center', marginTop:1 }}>
              {pf.emoji} <span style={{ color:pf.color }}>{pf.label}</span>
              {portfolio.length>0 && (() => {
                const val  = portfolio.reduce((a,p)=>a+p.shares*p.currentPrice,0);
                const cost = portfolio.reduce((a,p)=>a+p.shares*p.avgPrice,0);
                const pnlP = cost ? (val-cost)/cost*100 : 0;
                return (
                  <>
                    <span style={{ color:C.muted }}>·</span>
                    <span style={{ color:C.text, fontFamily:"'DM Mono',monospace" }}>{val.toLocaleString('es-ES',{maximumFractionDigits:0})}€</span>
                    {cost > 0 && <span style={{ color:pnlP>=0?C.green:C.red, fontWeight:600 }}>{pnlP>=0?'▲':'▼'}{Math.abs(pnlP).toFixed(1)}%</span>}
                  </>
                );
              })()}
            </div>
          </div>
        </div>

      </header>

      {/* Market Ticker — índices en vivo (visible si hay Cloudflare Worker) */}
      <MarketTicker />

      {/* Contenido */}
      <div style={{ flex:1, overflow:'hidden', position:'relative', paddingBottom:'calc(58px + env(safe-area-inset-bottom, 0px))' }}>
        {tab==='chat'      && <ChatTab profile={profile} portfolio={portfolio} userProfile={userProfile} />}
        {tab==='portfolio' && <PortfolioTab portfolio={portfolio} setPortfolio={setPortfolio} profile={profile} userProfile={userProfile} />}
        {tab==='invest'    && <InvestTab profile={profile} portfolio={portfolio} setPortfolio={setPortfolio} userProfile={userProfile} onNavigate={setTab} />}
        {tab==='research'  && <ResearchTab portfolio={portfolio} profile={profile} />}
        {tab==='control'   && <ControlTab />}
        {tab==='simulator' && <SimulatorTab />}
        {tab==='settings'  && <SettingsTab profile={profile} setProfile={handleSetProfile} userProfile={userProfile} setUserProfile={setUserProfile} />}
      </div>

      {/* Bottom Navigation */}
      <BottomNav
        tab={tab} setTab={setTab}
        alertCount={alertCount}
        onAlertOpen={() => { setShowAlerts(true); setAlertCount(0); }}
      />

      {/* Alert Center overlay */}
      {showAlerts && (
        <AlertCenter
          onClose={() => setShowAlerts(false)}
          onNavigate={(t) => { setShowAlerts(false); setTab(t); }}
        />
      )}
    </div>
  );
}

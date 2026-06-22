import { useState, useRef, useEffect } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts';
import {
  initNexus, getMemory, nexusChat, nexusResearch, nexusPrices, nexusMarketBriefing,
  nexusInvestmentProposal, classifyQuery, PROVIDER_META, PROFILES, EMPTY_PROFILE,
} from './nexus/index';
import type { AgentKey, ChatMessage, DisplayMessage, InvestmentProposal, Position, RouteResult, UserProfile } from './nexus/index';
import { callAnthropic } from './nexus/providers';

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
  `;
  document.head.appendChild(s);
};

/* ══════════════════════════════════════════════════════════════
   DESIGN TOKENS
══════════════════════════════════════════════════════════════ */
const C = {
  gold:'#c9a84c', goldL:'#e8c96a', goldD:'#a0732e',
  bg:'#07070e', surf:'#0a0a14', surf2:'#0d0d1c', surf3:'#111120',
  border:'#161626', border2:'#1e1e30',
  text:'#d8d8f0', muted:'#404060', faint:'#252540',
  green:'#2a9d6e', red:'#e05252', blue:'#5b9cf6', purple:'#9b6cf6',
};
const PIE_PAL = [C.gold, C.blue, C.green, C.purple, '#e8734a','#1abc9c','#e74c3c','#3498db'];

/* ══════════════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════════════ */
const NAV = [
  { id:'chat',      icon:'💬', label:'Chat'      },
  { id:'portfolio', icon:'📁', label:'Cartera'   },
  { id:'invest',    icon:'💰', label:'Invertir'  },
  { id:'research',  icon:'🔬', label:'Research'  },
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
const sGet = async (k:string) => { try { const v=localStorage.getItem(k); return v?JSON.parse(v):null; } catch { return null; } };
const sSet = async (k:string, v:unknown) => { try { localStorage.setItem(k,JSON.stringify(v)); } catch {} };

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

  const raw = await callAnthropic(
    [{ role:'user', content }],
    IMPORT_SYSTEM,
    'claude-sonnet-4-6',
  );
  const json = raw.replace(/```[a-z]*\n?|```/g, '').trim();
  const parsed = JSON.parse(json) as any[];
  return parsed.map((p, i) => ({
    id: Date.now() + i,
    ticker: String(p.ticker || '?').toUpperCase(),
    name: String(p.name || p.ticker || '?'),
    shares: +p.shares || 0,
    avgPrice: +p.avgPrice || 0,
    currentPrice: +p.currentPrice || +p.avgPrice || 0,
  })).filter(p => p.ticker !== '?' && p.shares > 0);
}

function ImportModal({ onImport, onClose }:{ onImport:(p:Position[])=>void; onClose:()=>void }) {
  const [tab,       setTab]     = useState<'paste'|'image'>('paste');
  const [text,      setText]    = useState('');
  const [image,     setImage]   = useState<{ b64:string; type:string; preview:string }|null>(null);
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
            <div style={{ fontSize:'.65em', color:C.muted, marginTop:2 }}>Claude lee tu broker y extrae las posiciones automáticamente</div>
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

function PortfolioTab({ portfolio, setPortfolio }:{ portfolio:Position[]; setPortfolio:(p:Position[])=>void }) {
  const empty = { ticker:'', name:'', shares:'', avgPrice:'', currentPrice:'' };
  const [form, setForm]       = useState(empty);
  const [adding, setAdding]   = useState(false);
  const [upd, setUpd]         = useState(false);
  const [importing, setImporting] = useState(false);

  const totalVal  = portfolio.reduce((a,p)=>a+p.shares*p.currentPrice,0);
  const totalCost = portfolio.reduce((a,p)=>a+p.shares*p.avgPrice,0);
  const pnl       = totalVal - totalCost;
  const pnlPct    = totalCost ? pnl/totalCost*100 : 0;

  const save = async (updated:Position[]) => { setPortfolio(updated); await sSet('aurum-portfolio', updated); };
  const add  = async () => {
    if (!form.ticker||!form.shares||!form.avgPrice) return;
    await save([...portfolio, { id:Date.now(), ticker:form.ticker.toUpperCase().trim(), name:form.name||form.ticker.toUpperCase().trim(), shares:+form.shares, avgPrice:+form.avgPrice, currentPrice:+(form.currentPrice||form.avgPrice) }]);
    setForm(empty); setAdding(false);
  };
  const remove = (id:number) => save(portfolio.filter(p=>p.id!==id));

  const refreshPrices = async () => {
    if (!portfolio.length) return;
    setUpd(true);
    try {
      const prices = await nexusPrices(portfolio.map(p=>p.ticker));
      await save(portfolio.map(p => { const f=prices.find(x=>x.ticker?.toUpperCase()===p.ticker); return f?{...p,currentPrice:f.price}:p; }));
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
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:16 }}>
        {statCard('Valor total', fmtEur(totalVal), C.goldL, totalCost?`coste ${fmtEur(totalCost)}`:'sin posiciones')}
        {statCard('P&L total', `${pnl>=0?'+':''}${fmtEur(pnl)}`, pnl>=0?C.green:C.red)}
        {statCard('Rendimiento', `${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%`, pnlPct>=0?C.green:C.red)}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:portfolio.length?'1fr 220px':'1fr', gap:14, alignItems:'start' }}>
        <Card>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:`1px solid ${C.border}` }}>
            <span style={{ fontSize:'.65em', letterSpacing:'1.5px', color:C.muted, textTransform:'uppercase' }}>Posiciones · {portfolio.length}</span>
            <div style={{ display:'flex', gap:7 }}>
              <button onClick={refreshPrices} disabled={!portfolio.length||upd}
                style={{ background:'transparent', border:`1px solid ${C.border2}`, color:upd?C.muted:C.gold, borderRadius:7, padding:'4px 10px', cursor:'pointer', fontSize:'.7em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', gap:5 }}>
                {upd?<Spinner/>:'↻'} {upd?'Actualizando…':'Actualizar precios'}
              </button>
              <button onClick={()=>setImporting(true)}
                style={{ background:'rgba(91,156,246,.1)', border:`1px solid #5b9cf644`, color:C.blue, borderRadius:7, padding:'4px 10px', cursor:'pointer', fontSize:'.7em', fontFamily:"'Sora',sans-serif", display:'flex', alignItems:'center', gap:5 }}>
                ✨ Importar broker
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
          {portfolio.length===0
            ? <div style={{ padding:'36px', textAlign:'center', color:C.muted, fontSize:'.82em' }}>Sin posiciones. Añade tus inversiones para hacer seguimiento.</div>
            : <>
                <div style={{ display:'grid', gridTemplateColumns:'80px 1fr 60px 75px 75px 90px 36px', padding:'7px 16px', fontSize:'.6em', color:C.muted, letterSpacing:'1px', textTransform:'uppercase', borderBottom:`1px solid ${C.border}` }}>
                  {['Ticker','Nombre','Acc.','P.Compra','P.Actual','P&L',''].map((h,i)=><span key={i}>{h}</span>)}
                </div>
                {portfolio.map(p=>{
                  const pnlVal=(p.currentPrice-p.avgPrice)*p.shares;
                  const pnlP=(p.currentPrice-p.avgPrice)/p.avgPrice*100;
                  return (
                    <div key={p.id} className="pos-row" style={{ display:'grid', gridTemplateColumns:'80px 1fr 60px 75px 75px 90px 36px', padding:'11px 16px', borderBottom:`1px solid ${C.border}22`, fontSize:'.82em', alignItems:'center', transition:'background .15s' }}>
                      <span style={{ color:C.gold, fontWeight:600, fontFamily:"'DM Mono',monospace" }}>{p.ticker}</span>
                      <span style={{ color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', paddingRight:8 }}>{p.name}</span>
                      <span style={{ color:C.muted, fontFamily:"'DM Mono',monospace" }}>{p.shares}</span>
                      <span style={{ color:C.muted, fontFamily:"'DM Mono',monospace" }}>{p.avgPrice}€</span>
                      <span style={{ color:C.text,  fontFamily:"'DM Mono',monospace" }}>{p.currentPrice}€</span>
                      <div>
                        <div style={{ color:pnlVal>=0?C.green:C.red, fontFamily:"'DM Mono',monospace", fontSize:'.9em' }}>{pnlVal>=0?'+':''}{pnlVal.toFixed(0)}€</div>
                        <div style={{ color:pnlVal>=0?C.green:C.red, fontSize:'.72em', opacity:.75 }}>{pnlP>=0?'+':''}{pnlP.toFixed(1)}%</div>
                      </div>
                      <button onClick={()=>remove(p.id)} style={{ background:'transparent', border:'none', color:'#252540', cursor:'pointer', fontSize:'.9em', borderRadius:6, padding:4, transition:'color .15s' }} onMouseEnter={e=>(e.target as HTMLElement).style.color=C.red} onMouseLeave={e=>(e.target as HTMLElement).style.color='#252540'}>✕</button>
                    </div>
                  );
                })}
              </>}
        </Card>
        {portfolio.length>0 && (
          <Card style={{ padding:'16px' }}>
            <div style={{ fontSize:'.62em', letterSpacing:'1.5px', color:C.muted, textTransform:'uppercase', marginBottom:12 }}>Distribución</div>
            <ResponsiveContainer width="100%" height={170}>
              <PieChart>
                <Pie data={chartData} cx="50%" cy="50%" innerRadius={48} outerRadius={78} paddingAngle={2} dataKey="value">
                  {chartData.map((_,i)=><Cell key={i} fill={PIE_PAL[i%PIE_PAL.length]} />)}
                </Pie>
                <Tooltip formatter={(v:any)=>[`${v.toLocaleString('es-ES')}€`]} contentStyle={{ background:C.surf3, border:`1px solid ${C.border}`, borderRadius:8, fontSize:'.76em', color:C.text }}/>
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display:'flex', flexDirection:'column', gap:5, marginTop:8 }}>
              {chartData.map((d,i)=>(
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:'.72em' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                    <div style={{ width:9, height:9, borderRadius:2, background:PIE_PAL[i%PIE_PAL.length], flexShrink:0 }}/>
                    <span style={{ color:C.muted }}>{d.name}</span>
                  </div>
                  <span style={{ color:C.text, fontFamily:"'DM Mono',monospace" }}>{totalVal?(d.value/totalVal*100).toFixed(1):0}%</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onImport={async positions => {
            await save([...portfolio, ...positions]);
            setImporting(false);
          }}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   RESEARCH TAB
══════════════════════════════════════════════════════════════ */
function ResearchTab() {
  const [asset,           setAsset]           = useState('');
  const [running,         setRunning]         = useState(false);
  const [steps,           setSteps]           = useState<{ label:string; status:string; provider?:string }[]>([]);
  const [curStep,         setCurStep]         = useState(-1);
  const [report,          setReport]          = useState<string|null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);

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

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>
      <div style={{ width:280, flexShrink:0, borderRight:`1px solid ${C.border}`, display:'flex', flexDirection:'column', padding:'20px 16px', gap:16, overflow:'auto', background:C.surf }}>
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.1em', fontWeight:600, color:C.goldL, marginBottom:3 }}>Research Profundo</div>
          <div style={{ fontSize:'.7em', color:C.muted, lineHeight:1.5 }}>Pipeline multi-modelo: GPT-4o Search para datos en vivo → DeepSeek para riesgos → Claude para síntesis</div>
        </div>
        <div>
          <div style={{ fontSize:'.62em', letterSpacing:'2px', color:C.muted, textTransform:'uppercase', marginBottom:7 }}>Activo a investigar</div>
          <input value={asset} onChange={e=>setAsset(e.target.value)} onKeyDown={e=>e.key==='Enter'&&run()}
            placeholder="Ej: Apple, VWCE, Bitcoin, Inditex…" style={{ ...inputBase, marginBottom:8 }} />
          <button onClick={run} disabled={running||!asset.trim()}
            style={{ width:'100%', padding:'9px', background:asset.trim()&&!running?C.gold:'#1a1a28', border:'none', borderRadius:9, color:asset.trim()&&!running?'#07070e':C.muted, fontWeight:600, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif", transition:'all .18s', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
            {running?<><Spinner/>Investigando…</>:'🔬 Iniciar Research'}
          </button>
          <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:14 }}>
            <div style={{ fontSize:'.62em', letterSpacing:'2px', color:C.muted, textTransform:'uppercase', marginBottom:7 }}>Mercados hoy</div>
            <button onClick={runBriefing} disabled={briefingLoading || running}
              style={{ width:'100%', padding:'9px', background:briefingLoading?'#1a1a28':`${C.blue}18`, border:`1px solid ${briefingLoading?C.border:C.blue+'44'}`, borderRadius:9, color:briefingLoading?C.muted:C.blue, fontWeight:600, cursor:'pointer', fontSize:'.82em', fontFamily:"'Sora',sans-serif", transition:'all .18s', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
              {briefingLoading?<><Spinner/>Cargando…</>:'📊 Briefing diario'}
            </button>
          </div>
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

      <div style={{ flex:1, overflow:'auto', padding:'24px 28px' }}>
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
                  <ProviderBadge provider="anthropic" model="claude-sonnet-4-6" />
                </div>
              </div>
            </div>
            <div style={{ fontSize:'.88em', lineHeight:1.78, color:C.text }}><Md text={report} /></div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   SIMULATOR TAB
══════════════════════════════════════════════════════════════ */
function SimulatorTab() {
  const [initial, setInitial] = useState(10000);
  const [monthly, setMonthly] = useState(300);
  const [rate,    setRate]    = useState(7);
  const [years,   setYears]   = useState(20);

  const data:{ año:number; 'Valor cartera':number; 'Capital aportado':number }[] = [];
  let balance = initial;
  for (let y=0; y<=years; y++) {
    data.push({ año:y, 'Valor cartera':Math.round(balance), 'Capital aportado':Math.round(initial+monthly*12*y) });
    balance = balance*(1+rate/100)+monthly*12;
  }
  const final    = data.at(-1)!['Valor cartera'];
  const aportado = data.at(-1)!['Capital aportado'];
  const ganancia = final - aportado;

  const sliders = [
    { label:'Capital inicial',       val:initial, set:setInitial, min:0,  max:100000, step:500, fmt:(v:number)=>`${v.toLocaleString('es-ES')}€` },
    { label:'Aportación mensual',    val:monthly, set:setMonthly, min:0,  max:2000,   step:50,  fmt:(v:number)=>`${v}€/mes` },
    { label:'Rentabilidad esperada', val:rate,    set:setRate,    min:1,  max:20,     step:.5,  fmt:(v:number)=>`${v}% anual` },
    { label:'Horizonte temporal',    val:years,   set:setYears,   min:1,  max:40,     step:1,   fmt:(v:number)=>`${v} años` },
  ];
  const stats:[string,string,string][] = [
    ['Capital final',   `${final.toLocaleString('es-ES')}€`,    C.goldL],
    ['Total aportado',  `${aportado.toLocaleString('es-ES')}€`, C.text],
    ['Ganancias netas', `+${ganancia.toLocaleString('es-ES')}€`,C.green],
    ['Multiplicador',   `×${(final/aportado).toFixed(2)}`,      C.blue],
    ['Retorno total',   `${(ganancia/aportado*100).toFixed(0)}%`,C.purple],
  ];

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>
      <div style={{ width:290, flexShrink:0, borderRight:`1px solid ${C.border}`, padding:'22px 18px', display:'flex', flexDirection:'column', gap:20, overflow:'auto', background:C.surf }}>
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.12em', fontWeight:600, color:C.goldL, marginBottom:3 }}>Simulador de Cartera</div>
          <div style={{ fontSize:'.72em', color:C.muted, lineHeight:1.5 }}>Interés compuesto con aportaciones periódicas — calculado localmente, sin IA</div>
        </div>
        {sliders.map(s=>(
          <div key={s.label}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
              <span style={{ fontSize:'.72em', color:C.muted }}>{s.label}</span>
              <span style={{ fontSize:'.78em', color:C.gold, fontFamily:"'DM Mono',monospace" }}>{s.fmt(s.val)}</span>
            </div>
            <input type="range" min={s.min} max={s.max} step={s.step} value={s.val} onChange={e=>s.set(+e.target.value)} style={{ width:'100%' }} />
          </div>
        ))}
        <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:11, overflow:'hidden' }}>
          {stats.map(([l,v,c])=>(
            <div key={l} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'9px 14px', borderBottom:`1px solid ${C.border}22` }}>
              <span style={{ fontSize:'.73em', color:C.muted }}>{l}</span>
              <span style={{ fontSize:'.82em', fontWeight:600, color:c, fontFamily:"'DM Mono',monospace" }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize:'.63em', color:C.faint, lineHeight:1.5 }}>⚠️ Simulación orientativa. No incluye impuestos, inflación ni comisiones.</div>
      </div>
      <div style={{ flex:1, padding:'22px 20px', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ fontSize:'.62em', letterSpacing:'2px', color:C.muted, textTransform:'uppercase', marginBottom:16 }}>Proyección · {years} años</div>
        <div style={{ flex:1, minHeight:0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top:10, right:20, left:10, bottom:0 }}>
              <defs>
                <linearGradient id="gGold" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.gold} stopOpacity={.35}/><stop offset="95%" stopColor={C.gold} stopOpacity={.02}/>
                </linearGradient>
                <linearGradient id="gBlue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.blue} stopOpacity={.22}/><stop offset="95%" stopColor={C.blue} stopOpacity={.01}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161626"/>
              <XAxis dataKey="año" stroke={C.muted} tick={{ fontSize:11, fill:C.muted }} tickFormatter={(v:number)=>`A${v}`}/>
              <YAxis stroke={C.muted} tick={{ fontSize:11, fill:C.muted }} tickFormatter={(v:number)=>v>=1000?`${(v/1000).toFixed(0)}k€`:`${v}€`}/>
              <Tooltip contentStyle={{ background:C.surf3, border:`1px solid ${C.border}`, borderRadius:9, fontSize:'.78em' }} formatter={(v:any)=>[`${v.toLocaleString('es-ES')}€`]} labelFormatter={(v:any)=>`Año ${v}`}/>
              <Legend wrapperStyle={{ fontSize:'.74em', color:C.muted, paddingTop:8 }}/>
              <Area type="monotone" dataKey="Capital aportado" stroke={C.blue} strokeWidth={1.5} fill="url(#gBlue)"/>
              <Area type="monotone" dataKey="Valor cartera"    stroke={C.gold} strokeWidth={2.5} fill="url(#gGold)"/>
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

function InvestTab({ profile, portfolio, setPortfolio, userProfile }:{
  profile: string;
  portfolio: Position[];
  setPortfolio: (p: Position[]) => void;
  userProfile: UserProfile;
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
      // ── Sin backend: registro local + guía manual ────────────────
      const newPositions: Position[] = proposal.trades.map((t, i) => ({
        id: Date.now() + i,
        ticker: t.ticker, name: t.name,
        shares: 1, avgPrice: t.amount, currentPrice: t.amount,
      }));
      const updated = [...portfolio, ...newPositions];
      setPortfolio(updated);
      await sSet('aurum-portfolio', updated);
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
                <ProviderBadge provider="anthropic" model="claude-sonnet-4-6" />
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
function BackendSection() {
  const [url,        setUrl]        = useState('');
  const [apiKey,     setApiKey]     = useState('');
  const [status,     setStatus]     = useState<'idle'|'ok'|'error'>('idle');
  const [statusMsg,  setStatusMsg]  = useState('');
  const [trPhone,    setTrPhone]    = useState('');
  const [trPin,      setTrPin]      = useState('');
  const [trOtp,      setTrOtp]      = useState('');
  const [authPhase,  setAuthPhase]  = useState<'idle'|'otp'|'done'>('idle');
  const [authMsg,    setAuthMsg]    = useState('');
  const fs: React.CSSProperties    = { ...inputBase, padding:'8px 12px' };

  useState(() => {
    sGet('aurum-backend-config').then((cfg:any) => {
      if (cfg?.url)    setUrl(cfg.url);
      if (cfg?.apiKey) setApiKey(cfg.apiKey);
    });
  });

  const testConnection = async () => {
    setStatus('idle'); setStatusMsg('Conectando…');
    try {
      const res = await backendCall({ url, apiKey }, '/health');
      if (res.status === 'ok') {
        setStatus('ok');
        setStatusMsg(res.tr_authenticated ? '✓ Conectado · TR autenticado' : '✓ Conectado · TR no autenticado aún');
        await sSet('aurum-backend-config', { url, apiKey });
      } else {
        setStatus('error'); setStatusMsg('Respuesta inesperada');
      }
    } catch(e:any) {
      setStatus('error'); setStatusMsg(e.message);
    }
  };

  const sendOtp = async () => {
    setAuthMsg('Enviando…');
    try {
      await backendCall({ url, apiKey }, '/auth/init', 'POST', { phone: trPhone, pin: trPin });
      setAuthPhase('otp'); setAuthMsg('OTP enviado a tu teléfono TR →');
    } catch(e:any) { setAuthMsg(`Error: ${e.message}`); }
  };

  const verifyOtp = async () => {
    setAuthMsg('Verificando…');
    try {
      await backendCall({ url, apiKey }, '/auth/verify', 'POST', { otp: trOtp });
      setAuthPhase('done'); setAuthMsg('✓ Trade Republic autenticado. AURUM puede ejecutar órdenes.');
    } catch(e:any) { setAuthMsg(`Error: ${e.message}`); }
  };

  const statusColor = status === 'ok' ? C.green : status === 'error' ? C.red : C.muted;

  return (
    <div>
      <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:'1.18em', fontWeight:600, color:C.goldL, marginBottom:4 }}>Backend Proxmox</div>
      <div style={{ fontSize:'.74em', color:C.muted, marginBottom:14 }}>Conecta el servidor local para ejecución automática de órdenes en Trade Republic.</div>
      <div style={{ background:C.surf2, border:`1px solid ${C.border}`, borderRadius:13, padding:'18px 20px', display:'flex', flexDirection:'column', gap:14 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div>
            <div style={{ fontSize:'.65em', color:C.muted, marginBottom:5 }}>Backend URL (Tailscale)</div>
            <input value={url} onChange={e=>setUrl(e.target.value)} placeholder="http://100.x.x.x:8000" style={fs} />
          </div>
          <div>
            <div style={{ fontSize:'.65em', color:C.muted, marginBottom:5 }}>API Key (AURUM_API_KEY)</div>
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
            <div style={{ fontSize:'.68em', color:C.muted, marginBottom:10, letterSpacing:'1px', textTransform:'uppercase' }}>Autenticar Trade Republic</div>
            {authPhase === 'idle' && (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr auto', gap:8, alignItems:'end' }}>
                <div>
                  <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>Teléfono TR</div>
                  <input value={trPhone} onChange={e=>setTrPhone(e.target.value)} placeholder="+34612345678" style={{ ...fs, padding:'7px 10px' }} />
                </div>
                <div>
                  <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>PIN TR</div>
                  <input value={trPin} onChange={e=>setTrPin(e.target.value)} type="password" placeholder="••••" style={{ ...fs, padding:'7px 10px' }} />
                </div>
                <button onClick={sendOtp} style={{ background:C.gold, border:'none', borderRadius:8, padding:'7px 14px', color:'#07070e', fontWeight:600, cursor:'pointer', fontSize:'.78em', fontFamily:"'Sora',sans-serif", whiteSpace:'nowrap' }}>
                  Enviar OTP →
                </button>
              </div>
            )}
            {authPhase === 'otp' && (
              <div style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:8, alignItems:'end' }}>
                <div>
                  <div style={{ fontSize:'.6em', color:C.muted, marginBottom:4 }}>Código OTP recibido en tu móvil</div>
                  <input value={trOtp} onChange={e=>setTrOtp(e.target.value)} placeholder="1234" maxLength={6} style={{ ...fs, padding:'7px 10px', letterSpacing:'4px', fontFamily:"'DM Mono',monospace" }} />
                </div>
                <button onClick={verifyOtp} style={{ background:C.green, border:'none', borderRadius:8, padding:'7px 16px', color:'#07070e', fontWeight:600, cursor:'pointer', fontSize:'.78em', fontFamily:"'Sora',sans-serif" }}>
                  Verificar ✓
                </button>
              </div>
            )}
            {authMsg && <div style={{ fontSize:'.7em', color:C.muted, marginTop:8 }}>{authMsg}</div>}
          </div>
        )}
        {authPhase === 'done' && (
          <div style={{ fontSize:'.72em', color:C.green, padding:'8px 12px', background:`${C.green}0c`, borderRadius:8, border:`1px solid ${C.green}33` }}>
            ✓ {authMsg}
          </div>
        )}
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
              <div style={{ fontSize:'.65em', color:C.muted, marginBottom:5, letterSpacing:'.5px' }}>Notas adicionales para la IA</div>
              <textarea
                value={userProfile.notes}
                onChange={e => setUserProfile({ ...userProfile, notes: e.target.value })}
                placeholder="Ej: Trabajo en el sector tech, me interesan los ETFs de acumulación, tengo pérdidas fiscales pendientes de compensar…"
                rows={3}
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
              ['◈ AURUM',  'Asesor general',      'anthropic', 'claude-sonnet-4-6',      'Mejor calidad conversacional + búsqueda web'],
              ['🌐 MACRO', 'Análisis macro',       'openai',    'gpt-4o-search-preview',  'Datos macroeconómicos en tiempo real'],
              ['⚖️ RIESGO','Gestión de riesgos',   'deepseek',  'deepseek-reasoner (R1)', 'Razonamiento matemático profundo (VaR, Sharpe)'],
              ['🧾 FISCAL','Asesoría fiscal',       'anthropic', 'claude-sonnet-4-6',      'Interpretación de normativa fiscal española'],
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

      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   ROOT APP
══════════════════════════════════════════════════════════════ */
export default function App() {
  const [tab,         setTab]         = useState('chat');
  const [profile,     setProfile]     = useState('moderado');
  const [portfolio,   setPortfolio]   = useState<Position[]>([]);
  const [userProfile, setUserProfile] = useState<UserProfile>(EMPTY_PROFILE);

  useEffect(() => {
    bootstrap();
    initNexus();
    sGet('aurum-portfolio').then(p => { if (p) setPortfolio(p); });
    sGet('aurum-user-profile').then(p => { if (p) setUserProfile(p); });
  }, []);

  const navItem = NAV.find(n => n.id === tab);
  const pf      = PROFILES[profile];

  return (
    <div style={{ display:'flex', height:'100vh', width:'100%', background:C.bg, fontFamily:"'Sora',sans-serif", color:C.text, overflow:'hidden' }}>
      {/* Ambient */}
      <div style={{ position:'fixed', top:-120, left:-80, width:380, height:380, borderRadius:'50%', background:`radial-gradient(circle,${C.gold}09 0%,transparent 70%)`, animation:'orb-float 7s ease-in-out infinite', pointerEvents:'none', zIndex:0 }}/>
      <div style={{ position:'fixed', bottom:-80, right:250, width:300, height:300, borderRadius:'50%', background:`radial-gradient(circle,${C.blue}07 0%,transparent 70%)`, animation:'orb-float 9s ease-in-out 3s infinite', pointerEvents:'none', zIndex:0 }}/>
      <div style={{ position:'fixed', inset:0, backgroundImage:`linear-gradient(${C.gold}035 1px,transparent 1px),linear-gradient(90deg,${C.gold}035 1px,transparent 1px)`, backgroundSize:'44px 44px', pointerEvents:'none', zIndex:0 }}/>

      {/* Side nav */}
      <nav style={{ width:62, flexShrink:0, background:'#09091a', borderRight:`1px solid ${C.border}`, display:'flex', flexDirection:'column', alignItems:'center', padding:'14px 0 16px', gap:3, zIndex:10 }}>
        <div style={{ width:40, height:40, borderRadius:11, background:`linear-gradient(135deg,${C.goldD},${C.goldL})`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, fontWeight:800, color:'#07070e', fontFamily:"'Cormorant Garamond',serif", boxShadow:`0 0 22px ${C.gold}45`, marginBottom:14, flexShrink:0 }}>A</div>
        {NAV.map(n=>(
          <button key={n.id} className="nav-icon" onClick={()=>setTab(n.id)} title={n.label}
            style={{ width:44, height:44, borderRadius:11, background:tab===n.id?`${C.gold}18`:'transparent', border:`1px solid ${tab===n.id?C.gold+'44':'transparent'}`, color:tab===n.id?C.gold:C.muted, cursor:'pointer', fontSize:'1.22em', display:'flex', alignItems:'center', justifyContent:'center', transition:'all .18s', flexShrink:0 }}>
            {n.icon}
          </button>
        ))}
        <div style={{ flex:1 }}/>
        <div style={{ display:'flex', flexDirection:'column', gap:4, alignItems:'center', paddingTop:8, borderTop:`1px solid ${C.border}`, width:'100%' }}>
          {Object.entries(PROFILES).map(([key,p])=>(
            <button key={key} onClick={()=>setProfile(key)} title={`Perfil: ${p.label}`}
              style={{ width:32, height:32, borderRadius:9, background:profile===key?p.color+'1a':'transparent', border:`1px solid ${profile===key?p.color+'55':'transparent'}`, cursor:'pointer', fontSize:'.9em', transition:'all .18s', display:'flex', alignItems:'center', justifyContent:'center' }}>
              {p.emoji}
            </button>
          ))}
        </div>
      </nav>

      {/* Main */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0, zIndex:5 }}>
        <header style={{ padding:'11px 20px', borderBottom:`1px solid ${C.border}`, background:'rgba(9,9,18,.97)', backdropFilter:'blur(16px)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:'1.1em' }}>{navItem?.icon}</span>
            <div>
              <div style={{ fontSize:'.83em', fontWeight:500, color:'#c0c0e0' }}>{navItem?.label}</div>
              <div style={{ fontSize:'.6em', color:C.faint, marginTop:1, display:'flex', gap:6, alignItems:'center' }}>
                AURUM Nexus · Perfil {pf.emoji} <span style={{ color:pf.color }}>{pf.label}</span>
                {portfolio.length>0 && <> · {portfolio.length} pos · {portfolio.reduce((a,p)=>a+p.shares*p.currentPrice,0).toLocaleString('es-ES',{maximumFractionDigits:0})}€</>}
              </div>
            </div>
          </div>
          {/* Provider indicators */}
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            {Object.entries(PROVIDER_META).map(([k,v])=>(
              <div key={k} style={{ display:'flex', alignItems:'center', gap:4 }}>
                <div style={{ width:5, height:5, borderRadius:'50%', background:v.color, boxShadow:`0 0 5px ${v.color}` }}/>
                <span style={{ fontSize:'.58em', color:v.color, fontFamily:"'DM Mono',monospace" }}>{v.short}</span>
              </div>
            ))}
          </div>
        </header>

        <div style={{ flex:1, overflow:'hidden', position:'relative' }}>
          {tab==='chat'      && <ChatTab profile={profile} portfolio={portfolio} userProfile={userProfile} />}
          {tab==='portfolio' && <PortfolioTab portfolio={portfolio} setPortfolio={setPortfolio} />}
          {tab==='invest'    && <InvestTab profile={profile} portfolio={portfolio} setPortfolio={setPortfolio} userProfile={userProfile} />}
          {tab==='research'  && <ResearchTab />}
          {tab==='simulator' && <SimulatorTab />}
          {tab==='settings'  && <SettingsTab profile={profile} setProfile={setProfile} userProfile={userProfile} setUserProfile={setUserProfile} />}
        </div>
      </div>
    </div>
  );
}

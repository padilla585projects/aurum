/**
 * commands.ts — Intérprete de comandos en lenguaje natural para el chat.
 *
 * Flujo:
 *   1. detectActionIntent(msg) detecta si el usuario quiere ejecutar algo
 *   2. executeCommand(cmd, ...) lo envía al backend /do o lo ejecuta directo
 */

import type { Position, UserProfile } from './types';

export interface CommandIntent {
  type: 'invest' | 'portfolio' | 'auto_on' | 'auto_off' | 'status' | 'computer' | 'none';
  amount?: number;
  url?: string;
  raw: string;
}

export interface CommandResult {
  success:  boolean;
  message:  string;
  data?:    unknown;
}

interface BackendConfig {
  url:    string;
  apiKey: string;
}

// ── Detección de intención ───────────────────────────────────────────────────

const INVEST_RE  = /invier(?:te|tir|tiendo|tamos)\s+([\d,.]+)\s*€?|compra\s+([\d,.]+)\s*€?|([\d,.]+)\s*€?\s+(?:en|de)\s+\w/i;
const AMOUNT_RE  = /([\d,.]+)\s*€/;
const AUTO_ON_RE  = /(?:activ|enci?end?e?|habilit)\w*\s+(?:el\s+)?(?:modo\s+)?auto(?:nómo|nomo)?/i;
const AUTO_OFF_RE = /(?:desactiv|apag|deshabilit)\w*\s+(?:el\s+)?(?:modo\s+)?auto(?:nómo|nomo)?/i;
const PORTFOLIO_RE = /(?:ver?|muéstr?a?me?|dame?|cómo\s+(?:está|va)|estado\s+de)\s+(?:mi\s+)?(?:cartera|portfolio|posicion(?:es)?|inversiones)/i;
const STATUS_RE   = /(?:estado|status)\s+(?:del\s+)?(?:sistema|backend|servidor|aurum)/i;
// Computer-use: control de PC, navegador, apps externas
const COMPUTER_RE = /(?:abre?|navega?\s+a?|accede?\s+a?|controla?|ejecuta?|abre?\s+el?\s+navegador|captura\s+pantalla|screenshot|saldo\s+de\s+(?:revolut|n26|bizum|banco|bbva|santander|ing|paypal|binance)|transfiere?\s+(?:dinero|euros?)|paga?\s+|log(?:in|ínate?)\s+(?:en|a))/i;

export function detectActionIntent(message: string): CommandIntent {
  const lower = message.toLowerCase().trim();

  if (AUTO_ON_RE.test(lower)) {
    const m = AMOUNT_RE.exec(message);
    return { type: 'auto_on', amount: m ? parseFloat(m[1].replace(',', '.')) : undefined, raw: message };
  }
  if (AUTO_OFF_RE.test(lower)) {
    return { type: 'auto_off', raw: message };
  }
  if (PORTFOLIO_RE.test(lower)) {
    return { type: 'portfolio', raw: message };
  }
  if (STATUS_RE.test(lower)) {
    return { type: 'status', raw: message };
  }
  if (INVEST_RE.test(lower)) {
    const m = AMOUNT_RE.exec(message);
    const amount = m ? parseFloat(m[1].replace(',', '.')) : undefined;
    return { type: 'invest', amount, raw: message };
  }
  if (COMPUTER_RE.test(lower)) {
    return { type: 'computer', raw: message };
  }

  return { type: 'none', raw: message };
}

// ── Ejecución de comandos vía backend /do ────────────────────────────────────

export async function executeCommand(
  intent:    CommandIntent,
  portfolio: Position[],
  profile:   string,
  user:      UserProfile,
  backend:   BackendConfig,
): Promise<CommandResult> {
  if (intent.type === 'none') {
    return { success: false, message: 'Sin acción detectada.' };
  }

  // Computer-use: rutar al agente local o navegador según disponibilidad
  if (intent.type === 'computer') {
    try {
      // Primero intenta agente local (control real de PC); si offline, usa Playwright en servidor
      const status = await getAgentStatus(backend);
      let result: ComputerTaskResult;
      if (status.connected) {
        result = await runLocalAgentTask(intent.raw, backend);
      } else {
        result = await runBrowserTask(intent.raw, intent.url ?? '', backend);
      }
      return {
        success: result.success,
        message: result.result || (result.success ? '✅ Tarea completada.' : '❌ Falló.'),
        data:    result,
      };
    } catch (err) {
      return { success: false, message: `Error en computer-use: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const portfolioCtx = portfolio.map(p => ({
    ticker: p.ticker,
    name:   p.name,
    value:  +(p.shares * p.currentPrice).toFixed(0),
  }));

  try {
    const res = await fetch(`${backend.url}/do`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aurum-Key':   backend.apiKey,
      },
      body: JSON.stringify({
        command: intent.raw,
        capital: intent.amount ?? 0,
        context: {
          profile,
          portfolio:   portfolioCtx,
          userName:    user.name,
          userHorizon: user.horizon,
        },
      }),
    });

    if (!res.ok) throw new Error(`Backend ${res.status}: ${await res.text()}`);
    const data = await res.json() as {
      action:   string;
      message:  string;
      executed: boolean;
      trades?:  Array<{ ticker: string; amount: number; status: string }>;
      portfolio?: unknown[];
      cash?:    number;
      status?:  Record<string, unknown>;
    };

    return {
      success: data.executed,
      message: data.message || formatActionResult(data),
      data,
    };
  } catch (err) {
    return { success: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function formatActionResult(data: { action: string; trades?: Array<{ ticker: string; amount: number; status: string }>; cash?: number; status?: Record<string, unknown> }): string {
  if (data.action === 'invest' && data.trades?.length) {
    const ok    = data.trades.filter(t => t.status === 'executed');
    const fails = data.trades.filter(t => t.status !== 'executed');
    const lines = ok.map(t => `✅ ${t.ticker}: ${t.amount.toFixed(0)}€`);
    if (fails.length) lines.push(...fails.map(t => `❌ ${t.ticker}: error`));
    return lines.join('\n');
  }
  if (data.action === 'portfolio' && data.cash !== undefined) {
    return `Saldo disponible: ${data.cash.toFixed(2)}€`;
  }
  if (data.action === 'status' && data.status) {
    const s = data.status;
    return (
      `TR: ${s['tr_authenticated'] ? '✅' : '❌'} | ` +
      `Auto: ${s['auto_enabled'] ? '🟢' : '🔴'} | ` +
      `Máx: ${s['max_amount']}€`
    );
  }
  return '';
}

// ── Computer control: browser automation + local agent ───────────────────────

export interface ComputerTaskResult {
  success:        boolean;
  result:         string;
  steps?:         number;
  screenshot_b64?: string;
}

/** Ejecuta una tarea en un navegador controlado por Playwright + Claude Vision (corre en el servidor). */
export async function runBrowserTask(
  task:        string,
  startUrl:    string,
  backend:     BackendConfig,
  credentials?: { username: string; password: string },
): Promise<ComputerTaskResult> {
  const res = await fetch(`${backend.url}/computer`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Aurum-Key': backend.apiKey },
    body: JSON.stringify({ task, url: startUrl, credentials: credentials ?? {}, headless: true, max_steps: 25 }),
  });
  if (!res.ok) throw new Error(`Backend ${res.status}: ${await res.text()}`);
  return res.json() as Promise<ComputerTaskResult>;
}

/** Ejecuta una tarea en el PC del usuario vía local agent + Claude Vision. */
export async function runLocalAgentTask(
  task:    string,
  backend: BackendConfig,
): Promise<ComputerTaskResult> {
  const res = await fetch(`${backend.url}/agent/do`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Aurum-Key': backend.apiKey },
    body: JSON.stringify({ task }),
  });
  if (!res.ok) throw new Error(`Backend ${res.status}: ${await res.text()}`);
  return res.json() as Promise<ComputerTaskResult>;
}

/** Envía un comando low-level al agente local (screenshot, click, type, etc.). */
export async function sendAgentCommand(
  command: Record<string, unknown>,
  backend: BackendConfig,
): Promise<unknown> {
  const res = await fetch(`${backend.url}/agent/command`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Aurum-Key': backend.apiKey },
    body: JSON.stringify({ command, wait_result: true, timeout_sec: 15 }),
  });
  if (!res.ok) throw new Error(`Backend ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Devuelve si el agente local está conectado. */
export async function getAgentStatus(backend: BackendConfig): Promise<{ connected: boolean; info: unknown }> {
  const res = await fetch(`${backend.url}/agent/status`, {
    headers: { 'X-Aurum-Key': backend.apiKey },
  });
  if (!res.ok) return { connected: false, info: null };
  return res.json();
}

// ── Helper para el chat: wrap de resultado como mensaje de assistant ─────────

export function commandResultToMessage(intent: CommandIntent, result: CommandResult): string {
  if (!result.success && result.message.startsWith('Sin acción')) return '';

  const prefix: Record<CommandIntent['type'], string> = {
    invest:    '💸 Inversión ejecutada',
    portfolio: '📊 Cartera',
    auto_on:   '🟢 Modo autónomo',
    auto_off:  '🔴 Modo autónomo',
    status:    '⚙️ Estado',
    computer:  '🖥️ Control PC',
    none:      '',
  };

  const head = prefix[intent.type] || '';
  if (!result.success) return `${head}: ❌ ${result.message}`;
  return `${head}: ${result.message || '✅ Completado'}`;
}

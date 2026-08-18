/**
 * Tipos mínimos del entorno de Cloudflare Pages Functions.
 *
 * Se declaran aquí en lugar de depender de @cloudflare/workers-types para no
 * añadir una dependencia más al proyecto; solo cubren lo que AURUM usa.
 */

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number; duration?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  first<T = unknown>(column: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface Env {
  DB: D1Database;

  /** Claves de los proveedores de IA (nunca salen del edge). */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;

  /** Secreto para firmar valores efímeros (state de OAuth). Obligatorio. */
  AURUM_SIGNING_SECRET: string;
  /** Alta del primer owner. Se borra tras crear la cuenta inicial. */
  AURUM_BOOTSTRAP_SECRET?: string;
  /** Orígenes autorizados, separados por comas. Sin comodines. */
  AURUM_ALLOWED_ORIGINS?: string;

  /** Google OAuth. Si faltan, esa vía de login queda desactivada. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** URL pública de la app, para construir el redirect_uri. */
  AURUM_PUBLIC_URL?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: 'owner' | 'user';
  status: 'active' | 'suspended';
}

/** Lo que el middleware deja disponible para cada Function. */
export interface AurumData extends Record<string, unknown> {
  user?: SessionUser;
  sessionId?: string;
  requestId: string;
}

export interface PagesContext {
  request: Request;
  env: Env;
  params: Record<string, string | string[]>;
  data: AurumData;
  next: (input?: Request) => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
}

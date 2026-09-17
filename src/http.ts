import {
  EgestiaAuthError,
  EgestiaEmissionError,
  EgestiaError,
  EgestiaNetworkError,
  EgestiaScopeError,
  EgestiaValidationError,
} from './errors.js';

export interface PeticionOpciones {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  /**
   * Si la operación se puede repetir sin consecuencias.
   *
   * Las lecturas siempre. Una emisión SÓLO si lleva referencia: ahí Egestia
   * devuelve el documento ya creado en vez de emitir otro. Sin referencia, un
   * reintento significaría un segundo DTE y un folio del CAF quemado, así que
   * el cliente prefiere fallar antes que insistir.
   */
  repetible: boolean;
  /** Devuelve el cuerpo crudo (XML, PDF) en vez de JSON. */
  crudo?: boolean;
}

const VERSION = '1.1.0';

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpCliente {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly reintentos: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: {
    apiKey: string;
    baseUrl: string;
    timeout: number;
    reintentos: number;
    appName?: string;
    fetch?: typeof globalThis.fetch;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeout = opts.timeout;
    this.reintentos = opts.reintentos;
    this.userAgent = [opts.appName, `egestia-sdk/${VERSION}`].filter(Boolean).join(' ');

    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new EgestiaError(
        'Este entorno no trae fetch. Usa Node 18 o pasa una implementación en `fetch`.',
        0, 'config',
      );
    }
    this.fetchImpl = f.bind(globalThis);
  }

  async pedir<T>(opts: PeticionOpciones): Promise<T> {
    const intentosMax = opts.repetible ? this.reintentos + 1 : 1;
    let ultimo: EgestiaError | null = null;

    for (let intento = 1; intento <= intentosMax; intento += 1) {
      try {
        return await this.unaVez<T>(opts);
      } catch (err) {
        const e = err as EgestiaError;
        // Un 400 no mejora repitiéndolo, y un 502 de emisión tampoco: el
        // documento ya existe y hay que mirarlo, no volver a mandarlo.
        if (!(e instanceof EgestiaError) || !e.retriable || e instanceof EgestiaEmissionError) throw e;
        ultimo = e;
        if (intento < intentosMax) {
          // Espera creciente: 400ms, 800ms, 1600ms…
          await esperar(400 * 2 ** (intento - 1));
        }
      }
    }

    throw ultimo!;
  }

  private async unaVez<T>(opts: PeticionOpciones): Promise<T> {
    const url = new URL(this.baseUrl + opts.path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), this.timeout);

    let respuesta: Response;
    try {
      respuesta = await this.fetchImpl(url.toString(), {
        method: opts.method,
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
          Accept: opts.crudo ? '*/*' : 'application/json',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: control.signal,
      });
    } catch (err) {
      const causa = err as Error;
      const mensaje = causa.name === 'AbortError'
        ? `Egestia no respondió en ${this.timeout} ms`
        : `No se pudo conectar con Egestia: ${causa.message}`;
      throw new EgestiaNetworkError(mensaje, causa);
    } finally {
      clearTimeout(reloj);
    }

    if (opts.crudo && respuesta.ok) return (await respuesta.text()) as T;

    const texto = await respuesta.text();
    let cuerpo: any = null;
    try { cuerpo = texto ? JSON.parse(texto) : null; } catch { cuerpo = { error: texto }; }

    if (respuesta.ok) {
      // `?? cuerpo` no sirve: cuando la API responde `{ data: null }` —«esa
      // venta todavía no tiene documento»— el null se tomaba por «no hay campo»
      // y se devolvía el sobre entero en vez del null.
      const tieneSobre = cuerpo !== null && typeof cuerpo === 'object' && 'data' in cuerpo;
      return (tieneSobre ? cuerpo.data : cuerpo) as T;
    }

    throw this.aError(respuesta.status, cuerpo);
  }

  /** Traduce la respuesta de la API al error que le sirve a quien integra. */
  private aError(status: number, cuerpo: any): EgestiaError {
    const mensaje = cuerpo?.error || cuerpo?.message || `Egestia respondió ${status}`;

    if (status === 401) return new EgestiaAuthError(mensaje, status, cuerpo);
    if (status === 403) return new EgestiaScopeError(mensaje, cuerpo);
    if (status === 400 || status === 422) return new EgestiaValidationError(mensaje, cuerpo);

    // 502 con `data.id`: el documento SÍ se creó, sólo no se emitió.
    if (status === 502 && cuerpo?.data?.id) {
      return new EgestiaEmissionError(mensaje, cuerpo.data.id, cuerpo.data.status ?? null, cuerpo);
    }

    return new EgestiaError(mensaje, status, status >= 500 ? 'server' : 'client', cuerpo);
  }
}

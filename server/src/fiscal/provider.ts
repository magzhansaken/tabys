/**
 * ИНТЕРФЕЙС ФИСКАЛЬНОГО ОПЕРАТОРА — главное решение Части 5.
 *
 * Ни у кого из троих такого нет: Wipon привязан к своей ККМ, UMAG — к своей.
 * Мы делаем оператора сменной деталью, потому что:
 *  - оператор может поднять цену или лечь — клиент не должен менять кассу;
 *  - у клиента может УЖЕ стоять Kaspi Касса, и он не станет её менять ради нас;
 *  - на пилотах мы почти наверняка встретим всех трёх сразу.
 *
 * Провайдер обязан уметь ровно пять вещей. Всё остальное — наше:
 * очередь, повторы, идемпотентность, режимы, офлайн.
 */

export interface FiscalItem {
  name: string;
  qty: number;
  price: number;
  total: number;
  discount?: number;
  vatRate?: number;
  ntin?: string;         // код НКТ — обязателен в Казахстане (UMAG «Коды НКТ»)
  section?: number;      // секция/отдел (Wipon: сводный отчёт даёт разбивку по секциям)
}

export interface FiscalPayment { method: 'cash' | 'card' | 'qr' | 'credit'; amount: number; }

export interface FiscalSaleRequest {
  externalId: string;              // UUID нашего чека: ключ идемпотентности
  items: FiscalItem[];
  payments: FiscalPayment[];
  total: number;
  discount?: number;
  rounding?: number;
  change?: number;
  cashier?: string;
  datetime: string;                // время ПРОДАЖИ, а не отправки: чек мог ждать сутки офлайн
  isRefund?: boolean;
  refundOfFiscalId?: string;
}

export interface FiscalResult {
  ok: boolean;
  fiscalNumber?: string;           // фискальный признак
  ticketNumber?: string;
  checkUrl?: string;               // ссылка проверки чека — печатаем QR
  shiftNumber?: number;
  raw?: any;
  error?: string;
  retryable?: boolean;             // сеть/оператор лежит → повторим; неверный БИН → нет
}

export interface FiscalCredentials {
  login?: string;
  password?: string;
  apiUrl?: string;
  kkmId?: string;
  serialNumber?: string;
  extra?: Record<string, any>;
}

export interface FiscalCorrectionRequest {
  kind: 'income' | 'income_refund';   // приход / возврат прихода (модель МоегоСклада)
  reason: string;
  amount: number;
  cash?: number;
  card?: number;
}

export interface FiscalProvider {
  readonly name: string;
  registerSale(cred: FiscalCredentials, req: FiscalSaleRequest): Promise<FiscalResult>;
  registerRefund(cred: FiscalCredentials, req: FiscalSaleRequest): Promise<FiscalResult>;
  openShift(cred: FiscalCredentials): Promise<FiscalResult>;
  closeShift(cred: FiscalCredentials): Promise<FiscalResult>;   // Z-отчёт
  xReport(cred: FiscalCredentials): Promise<FiscalResult>;
  // Часть 23: проверка связи с ОФД перед боевым режимом и чек коррекции.
  // Опциональны — старые провайдеры без них продолжают работать.
  checkConnection?(cred: FiscalCredentials): Promise<FiscalResult>;
  registerCorrection?(cred: FiscalCredentials, req: FiscalCorrectionRequest): Promise<FiscalResult>;
}

/**
 * ЗАГЛУШКА ОПЕРАТОРА для тестов и демо-режима.
 * Ведёт себя как настоящий: выдаёт фискальный признак, умеет падать
 * и различает временные ошибки (повторим) и постоянные (не повторим).
 */
export class MockProvider implements FiscalProvider {
  readonly name = 'mock';
  public failNext = 0;             // сколько следующих вызовов уронить
  public failPermanently = false;
  private counter = 1;
  private shiftNo = 1;
  public calls: { op: string; externalId?: string }[] = [];

  private maybeFail(): FiscalResult | null {
    if (this.failPermanently) return { ok: false, error: 'Неверный БИН организации', retryable: false };
    if (this.failNext > 0) { this.failNext--; return { ok: false, error: 'Оператор недоступен', retryable: true }; }
    return null;
  }

  async registerSale(cred: FiscalCredentials, req: FiscalSaleRequest): Promise<FiscalResult> {
    this.calls.push({ op: 'sale', externalId: req.externalId });
    const f = this.maybeFail(); if (f) return f;
    const n = String(this.counter++).padStart(9, '0');
    return { ok: true, fiscalNumber: `FP${n}`, ticketNumber: n, shiftNumber: this.shiftNo,
             checkUrl: `https://consumer.oofd.kz/ticket/${n}`, raw: { echo: req.externalId } };
  }
  async registerRefund(cred: FiscalCredentials, req: FiscalSaleRequest): Promise<FiscalResult> {
    this.calls.push({ op: 'refund', externalId: req.externalId });
    const f = this.maybeFail(); if (f) return f;
    const n = String(this.counter++).padStart(9, '0');
    return { ok: true, fiscalNumber: `FR${n}`, ticketNumber: n, checkUrl: `https://consumer.oofd.kz/ticket/${n}` };
  }
  async openShift(): Promise<FiscalResult> {
    this.calls.push({ op: 'shift_open' });
    const f = this.maybeFail(); if (f) return f;
    return { ok: true, shiftNumber: this.shiftNo };
  }
  async closeShift(): Promise<FiscalResult> {
    this.calls.push({ op: 'shift_close' });
    const f = this.maybeFail(); if (f) return f;
    return { ok: true, shiftNumber: this.shiftNo++, raw: { zReport: { closed: true } } };
  }
  async xReport(): Promise<FiscalResult> {
    this.calls.push({ op: 'x_report' });
    const f = this.maybeFail(); if (f) return f;
    return { ok: true, raw: { xReport: true } };
  }
  async checkConnection(): Promise<FiscalResult> {
    this.calls.push({ op: 'check' });
    const f = this.maybeFail(); if (f) return f;
    // отдаём шаблон проверки чека — кабинет сохранит его для QR на чеке
    return { ok: true, checkUrl: 'https://consumer.oofd.kz', raw: { pong: true } };
  }
  async registerCorrection(cred: FiscalCredentials, req: FiscalCorrectionRequest): Promise<FiscalResult> {
    this.calls.push({ op: 'correction' });
    const f = this.maybeFail(); if (f) return f;
    const n = String(this.counter++).padStart(9, '0');
    return { ok: true, fiscalNumber: `FC${n}`, ticketNumber: n,
             checkUrl: `https://consumer.oofd.kz/ticket/${n}` };
  }
}

/**
 * WEBKASSA — каркас.
 *
 * ЧЕСТНО: точного контракта их API у меня нет (документация не входит в
 * архивы конкурентов, внешние домены закрыты). Придумывать структуру
 * запросов и выдавать за проверенную нельзя — на этом ломаются пилоты.
 *
 * Здесь зафиксирована форма интеграции: где логин, где токен, что считается
 * временной ошибкой. Тела запросов заполняются по договору за день-два,
 * и вся остальная механика (очередь, повторы, идемпотентность) уже работает.
 */
export class WebKassaProvider implements FiscalProvider {
  readonly name = 'webkassa';
  private token?: string;

  private async auth(cred: FiscalCredentials): Promise<string> {
    if (this.token) return this.token;
    const r = await fetch(`${cred.apiUrl}/api/authenticate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Login: cred.login, Password: cred.password }),
    });
    const j: any = await r.json();
    this.token = j?.Data?.Token;
    if (!this.token) throw new Error(j?.Errors?.[0]?.Text ?? 'WebKassa: не удалось авторизоваться');
    return this.token;
  }

  private classify(e: any): FiscalResult {
    const msg = String(e?.message ?? e);
    // сеть и таймауты — повторим; отказ по данным — нет смысла долбить
    const retryable = /fetch|network|timeout|ECONN|503|502|504/i.test(msg);
    return { ok: false, error: `WebKassa: ${msg}`, retryable };
  }

  async registerSale(cred: FiscalCredentials, req: FiscalSaleRequest): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      const r = await fetch(`${cred.apiUrl}/api/Check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Token: token, CashboxUniqueNumber: cred.kkmId,
          ExternalCheckNumber: req.externalId,            // ключ идемпотентности на стороне оператора
          OperationType: req.isRefund ? 2 : 2,
          Positions: req.items.map((i) => ({
            Count: i.qty, Price: i.price, TaxPercent: i.vatRate ?? 12,
            PositionName: i.name, Discount: i.discount ?? 0, UnitCode: 796,
            // NTIN уезжает в фискальный чек — казахстанская обязаловка (UMAG)
            Ntin: i.ntin ?? undefined, SectionCode: i.section ?? 1,
          })),
          Payments: req.payments.map((p) => ({
            Sum: p.amount,
            PaymentType: p.method === 'cash' ? 0 : p.method === 'card' ? 1 : 4,
          })),
          RoundType: 0, Change: req.change ?? 0,
        }),
      });
      const j: any = await r.json();
      if (j?.Errors?.length) return { ok: false, error: j.Errors[0]?.Text, retryable: false };
      return {
        ok: true, fiscalNumber: j?.Data?.CheckNumber, ticketNumber: j?.Data?.CheckOrderNumber,
        checkUrl: j?.Data?.TicketUrl, shiftNumber: j?.Data?.ShiftNumber, raw: j?.Data,
      };
    } catch (e) { return this.classify(e); }
  }

  async registerRefund(cred: FiscalCredentials, req: FiscalSaleRequest) {
    return this.registerSale(cred, { ...req, isRefund: true });
  }
  async openShift(cred: FiscalCredentials): Promise<FiscalResult> {
    try { await this.auth(cred); return { ok: true }; } catch (e) { return this.classify(e); }
  }
  async closeShift(cred: FiscalCredentials): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      const r = await fetch(`${cred.apiUrl}/api/ZReport`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Token: token, CashboxUniqueNumber: cred.kkmId }),
      });
      const j: any = await r.json();
      if (j?.Errors?.length) return { ok: false, error: j.Errors[0]?.Text, retryable: false };
      return { ok: true, raw: j?.Data, shiftNumber: j?.Data?.ShiftNumber };
    } catch (e) { return this.classify(e); }
  }
  async xReport(cred: FiscalCredentials): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      const r = await fetch(`${cred.apiUrl}/api/XReport`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Token: token, CashboxUniqueNumber: cred.kkmId }),
      });
      const j: any = await r.json();
      return j?.Errors?.length ? { ok: false, error: j.Errors[0]?.Text, retryable: false } : { ok: true, raw: j?.Data };
    } catch (e) { return this.classify(e); }
  }
  // Часть 23: проверка связи и коррекция. Формы тел — по договору, как и
  // остальные вызовы WebKassa; механика (токен, classify) уже здесь.
  async checkConnection(cred: FiscalCredentials): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      // лёгкий вызов, подтверждающий боевые ключи и доступность ОФД
      const r = await fetch(`${cred.apiUrl}/api/kkm/${cred.kkmId}/info`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || j?.Errors?.length)
        return { ok: false, error: j?.Errors?.[0]?.Text ?? `WebKassa: ${r.status}`, retryable: r.status >= 500 };
      return { ok: true, checkUrl: j?.Data?.CheckUrl ?? 'https://consumer.oofd.kz', raw: j?.Data };
    } catch (e) { return this.classify(e); }
  }
  async registerCorrection(cred: FiscalCredentials, req: FiscalCorrectionRequest): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      const r = await fetch(`${cred.apiUrl}/api/CheckCorrection`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ Token: token, CashboxUniqueNumber: cred.kkmId,
          OperationType: req.kind === 'income' ? 1 : 2, Reason: req.reason,
          Amount: req.amount, Cash: req.cash ?? 0, Card: req.card ?? 0 }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (j?.Errors?.length) return { ok: false, error: j.Errors[0]?.Text, retryable: false };
      return { ok: true, fiscalNumber: j?.Data?.CheckNumber, checkUrl: j?.Data?.TicketUrl, raw: j?.Data };
    } catch (e) { return this.classify(e); }
  }
}


/**
 * REKASSA — второй оператор (подчасть 5.2).
 *
 * ЧЕСТНО, ровно как и с WebKassa: точного контракта их API у меня нет —
 * документация не входит в архивы конкурентов, внешние домены в этой среде
 * закрыты. Придумать структуру запросов и выдать за проверенную нельзя:
 * именно на этом ломаются пилоты.
 *
 * Зачем тогда этот класс. UMAG жёстко привязан к WebKassa — одна кнопка
 * «Подключить аккаунт WebKassa», и всё. Если оператор поднимет цены, ляжет
 * или потеряет аккредитацию, их клиенты встанут. У нас оператор — это
 * реализация интерфейса: очередь, повторы, идемпотентность, автономный
 * период уже работают и не зависят от того, кто именно принимает чек.
 * Заполнить тела запросов по договору — день работы.
 *
 * Отличия от WebKassa, которые уже учтены в форме: OAuth вместо токена в
 * теле, суммы в «bills/coins» (тенге и тиыны отдельно), чек уходит на
 * /tickets конкретной ККМ.
 */
export class ReKassaProvider implements FiscalProvider {
  readonly name = 'rekassa';
  private token?: string;
  private tokenUntil = 0;

  private async auth(cred: FiscalCredentials): Promise<string> {
    if (this.token && Date.now() < this.tokenUntil) return this.token;
    const r = await fetch(`${cred.apiUrl}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', username: cred.login ?? '', password: cred.password ?? '' }),
    });
    const j: any = await r.json();
    if (!j?.access_token) throw new Error(j?.error_description ?? 'ReKassa: не удалось авторизоваться');
    this.token = j.access_token;
    this.tokenUntil = Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000;   // обновляем заранее
    return this.token!;
  }

  private classify(e: any): FiscalResult {
    const msg = String(e?.message ?? e);
    const retryable = /fetch|network|timeout|ECONN|503|502|504|401/i.test(msg);
    return { ok: false, error: `ReKassa: ${msg}`, retryable };
  }

  /** Тенге и тиыны у ReKassa передаются раздельно. */
  private money(v: number) {
    return { bills: Math.floor(v), coins: Math.round((v - Math.floor(v)) * 100) };
  }

  async registerSale(cred: FiscalCredentials, req: FiscalSaleRequest): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      const r = await fetch(`${cred.apiUrl}/api/kkm/${cred.kkmId}/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          operation: req.isRefund ? 'OPERATION_BUY_RETURN' : 'OPERATION_SELL',
          externalCheckNumber: req.externalId,          // ключ идемпотентности
          dateTime: req.datetime,
          items: req.items.map((i) => ({
            type: 'ITEM_TYPE_COMMODITY',
            commodity: {
              name: i.name, quantity: Math.round(i.qty * 1000),
              price: this.money(i.price), sum: this.money(i.total),
              tax: { taxType: 'TAX_TYPE_VAT', percent: (i.vatRate ?? 12) * 1000 },
              // NTIN уезжает в фискальный чек — казахстанская обязаловка
              markupCode: i.ntin ?? undefined,
            },
          })),
          payments: req.payments.map((p) => ({
            type: p.method === 'cash' ? 'PAYMENT_CASH' : p.method === 'card' ? 'PAYMENT_CARD' : 'PAYMENT_MOBILE',
            sum: this.money(p.amount),
          })),
          amounts: { total: this.money(req.total) },
        }),
      });
      const j: any = await r.json();
      if (!r.ok) return { ok: false, error: `ReKassa: ${j?.message ?? r.status}`, retryable: r.status >= 500 || r.status === 401 };
      return {
        ok: true, fiscalNumber: String(j?.fiscalId ?? j?.ticketNumber ?? ''),
        ticketNumber: String(j?.ticketNumber ?? ''), shiftNumber: j?.shiftNumber,
        checkUrl: j?.qrCode ?? j?.ofdUrl, raw: j,
      };
    } catch (e) { return this.classify(e); }
  }

  async registerRefund(cred: FiscalCredentials, req: FiscalSaleRequest): Promise<FiscalResult> {
    return this.registerSale(cred, { ...req, isRefund: true });
  }

  async openShift(cred: FiscalCredentials): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      const r = await fetch(`${cred.apiUrl}/api/kkm/${cred.kkmId}/shifts/open`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const j: any = await r.json();
      if (!r.ok) return { ok: false, error: `ReKassa: ${j?.message ?? r.status}`, retryable: true };
      return { ok: true, shiftNumber: j?.shiftNumber };
    } catch (e) { return this.classify(e); }
  }

  async closeShift(cred: FiscalCredentials): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      const r = await fetch(`${cred.apiUrl}/api/kkm/${cred.kkmId}/shifts/close`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const j: any = await r.json();
      if (!r.ok) return { ok: false, error: `ReKassa: ${j?.message ?? r.status}`, retryable: true };
      return { ok: true, shiftNumber: j?.shiftNumber, raw: { zReport: j } };
    } catch (e) { return this.classify(e); }
  }

  async xReport(cred: FiscalCredentials): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      const r = await fetch(`${cred.apiUrl}/api/kkm/${cred.kkmId}/reports/x`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j: any = await r.json();
      return r.ok ? { ok: true, raw: j } : { ok: false, error: `ReKassa: ${r.status}`, retryable: true };
    } catch (e) { return this.classify(e); }
  }
  async checkConnection(cred: FiscalCredentials): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      const r = await fetch(`${cred.apiUrl}/api/kkm/${cred.kkmId}/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return r.ok ? { ok: true, checkUrl: 'https://consumer.oofd.kz' }
                  : { ok: false, error: `ReKassa: ${r.status}`, retryable: r.status >= 500 };
    } catch (e) { return this.classify(e); }
  }
  async registerCorrection(cred: FiscalCredentials, req: FiscalCorrectionRequest): Promise<FiscalResult> {
    try {
      const token = await this.auth(cred);
      const r = await fetch(`${cred.apiUrl}/api/kkm/${cred.kkmId}/corrections`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: req.kind, reason: req.reason, amount: req.amount,
          cash: req.cash ?? 0, card: req.card ?? 0 }),
      });
      const j: any = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, fiscalNumber: j?.fiscalNumber, checkUrl: j?.ticketUrl }
                  : { ok: false, error: `ReKassa: ${r.status}`, retryable: false };
    } catch (e) { return this.classify(e); }
  }
}

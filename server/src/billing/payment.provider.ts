/**
 * ПРОВАЙДЕРЫ ОПЛАТЫ ПОДПИСКИ (часть 29).
 *
 * Абстракция как у фискальных провайдеров (часть 23): интерфейс один, боевые
 * реализации подключаются по договору. Kaspi Merchant API v2 (2026): создаём
 * счёт → получаем pay_url/QR → клиент платит → webhook «оплачено» с HMAC.
 *
 * ЧЕСТНО: точного контракта боевого Kaspi Merchant API в открытом доступе нет
 * (нужен договор мерчанта). Здесь зафиксирована ФОРМА: что на входе, что на
 * выходе, как проверяется подпись webhook. Тело боевого запроса заполняется
 * за день-два после подписания договора — вся остальная механика (счёт,
 * идемпотентность, пополнение, автопродление) уже работает.
 */
import * as crypto from 'crypto';

export interface CreateInvoiceRequest {
  accountId: string;
  amount: number;
  purpose: 'topup' | 'renew';
  description?: string;
}

export interface CreateInvoiceResult {
  ok: boolean;
  externalId?: string;   // id счёта у провайдера
  payUrl?: string;       // ссылка/QR для оплаты
  error?: string;
}

export interface PaymentProvider {
  readonly name: string;
  createInvoice(req: CreateInvoiceRequest): Promise<CreateInvoiceResult>;
  /** Проверка подписи webhook — подлинность уведомления об оплате */
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
}

/**
 * MOCK — для тестов и демо. Ведёт себя как настоящий: выдаёт externalId и
 * pay_url, подпись webhook проверяет по общему секрету.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private secret = 'mock-secret';
  private seq = 1;

  async createInvoice(req: CreateInvoiceRequest): Promise<CreateInvoiceResult> {
    const externalId = `MOCK-${Date.now()}-${this.seq++}`;
    return { ok: true, externalId, payUrl: `https://pay.mock.local/${externalId}` };
  }

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', this.secret).update(rawBody).digest('hex');
    return signature === expected;
  }

  /** помощник для тестов: подписать тело как это сделал бы провайдер */
  sign(rawBody: string): string {
    return crypto.createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }
}

/**
 * KASPI — каркас Merchant API v2. Тело запросов — по договору мерчанта.
 */
export class KaspiPaymentProvider implements PaymentProvider {
  readonly name = 'kaspi';
  constructor(private apiUrl: string, private merchantId: string, private secret: string) {}

  async createInvoice(req: CreateInvoiceRequest): Promise<CreateInvoiceResult> {
    try {
      const r = await fetch(`${this.apiUrl}/v2/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Merchant-Id': this.merchantId },
        body: JSON.stringify({ amount: req.amount, description: req.description ?? 'Оплата подписки' }),
        signal: AbortSignal.timeout(8000),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j?.message ?? `Kaspi: ${r.status}` };
      return { ok: true, externalId: j?.invoiceId, payUrl: j?.paymentUrl };
    } catch (e: any) {
      return { ok: false, error: `Kaspi недоступен: ${e.message}` };
    }
  }

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    // Kaspi подписывает тело HMAC-SHA256 общим секретом мерчанта
    const expected = crypto.createHmac('sha256', this.secret).update(rawBody).digest('hex');
    return signature === expected;
  }
}

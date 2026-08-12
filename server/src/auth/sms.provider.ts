/**
 * СМС-ШЛЮЗЫ КАЗАХСТАНА (этап 12).
 *
 * Три сервиса, между которыми выбирает владелец. Механика одинаковая,
 * поэтому переключение — одна строка в настройках, а не переделка:
 *
 *   mobizon   — работает с 2014, самый распространённый в КЗ;
 *   smsc      — крупный, много способов отправки;
 *   autocall  — кроме СМС умеет звонок с кодом (Flash Call): клиенту
 *               не приходит сообщение, а идёт короткий звонок, и код —
 *               последние цифры номера. Дешевле СМС.
 *
 * ВАЖНОЕ ПРО КАЗАХСТАН: операторы делят сообщения на транзакционные
 * (коды подтверждения), сервисные и рекламные — с разными правилами и
 * ценами. Для кодов нужно заранее зарегистрировать имя отправителя и
 * согласовать шаблон текста. Это делается один раз, но занимает дни,
 * поэтому шаблон здесь вынесен в настройку: подставить согласованный
 * текст можно будет без правки кода.
 *
 * ЧЕСТНО: боевые ключи выдаются по договору. Здесь зафиксирована форма
 * обращений; включается подстановкой ключа.
 */

export interface SmsResult { ok: boolean; id?: string; cost?: number; error?: string }

export interface SmsProvider {
  readonly name: string;
  send(phone: string, text: string): Promise<SmsResult>;
  /** Остаток на счету — чтобы коды не перестали приходить внезапно. */
  balance(): Promise<{ amount: number; currency: string } | null>;
}

/** Единый вид номера: сервисы принимают без плюса и пробелов. */
const digits = (phone: string) => String(phone).replace(/\D/g, '');

/** MOCK — для тестов и для работы, пока шлюз не подключён. */
export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock';
  public sent: { phone: string; text: string }[] = [];
  async send(phone: string, text: string): Promise<SmsResult> {
    this.sent.push({ phone, text });
    return { ok: true, id: 'mock-' + Date.now(), cost: 0 };
  }
  async balance() { return { amount: 0, currency: 'KZT' }; }
}

/** MOBIZON — самый распространённый в Казахстане. */
export class MobizonSmsProvider implements SmsProvider {
  readonly name = 'mobizon';
  constructor(private apiKey: string, private domain = 'api.mobizon.kz') {}

  async send(phone: string, text: string): Promise<SmsResult> {
    try {
      const url = `https://${this.domain}/service/message/sendSmsMessage` +
        `?output=json&api=v1&apiKey=${encodeURIComponent(this.apiKey)}`;
      const body = new URLSearchParams({ recipient: digits(phone), text });
      const r = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
      const j: any = await r.json().catch(() => ({}));
      // У них признак успеха — code 0, а не HTTP-статус.
      if (j?.code === 0) return { ok: true, id: String(j?.data?.messageId ?? '') };
      return { ok: false, error: j?.message ?? `Mobizon: ${r.status}` };
    } catch (e: any) { return { ok: false, error: `Mobizon недоступен: ${e.message}` }; }
  }

  async balance() {
    try {
      const r = await fetch(`https://${this.domain}/service/user/getownbalance?output=json&api=v1&apiKey=${encodeURIComponent(this.apiKey)}`,
        { signal: AbortSignal.timeout(10000) });
      const j: any = await r.json().catch(() => ({}));
      return j?.code === 0 ? { amount: Number(j.data?.balance ?? 0), currency: j.data?.currency ?? 'KZT' } : null;
    } catch { return null; }
  }
}

/** SMSC.KZ — крупный, работает с 2003 года. */
export class SmscSmsProvider implements SmsProvider {
  readonly name = 'smsc';
  constructor(private login: string, private password: string, private sender?: string) {}

  async send(phone: string, text: string): Promise<SmsResult> {
    try {
      const p = new URLSearchParams({
        login: this.login, psw: this.password, phones: digits(phone),
        mes: text, fmt: '3', charset: 'utf-8',
      });
      if (this.sender) p.set('sender', this.sender);
      const r = await fetch('https://smsc.kz/sys/send.php?' + p, { signal: AbortSignal.timeout(15000) });
      const j: any = await r.json().catch(() => ({}));
      if (j?.error) return { ok: false, error: j.error };
      return { ok: true, id: String(j?.id ?? ''), cost: Number(j?.cost ?? 0) };
    } catch (e: any) { return { ok: false, error: `SMSC недоступен: ${e.message}` }; }
  }

  async balance() {
    try {
      const r = await fetch(`https://smsc.kz/sys/balance.php?login=${encodeURIComponent(this.login)}&psw=${encodeURIComponent(this.password)}&fmt=3`,
        { signal: AbortSignal.timeout(10000) });
      const j: any = await r.json().catch(() => ({}));
      return j?.balance != null ? { amount: Number(j.balance), currency: 'KZT' } : null;
    } catch { return null; }
  }
}

/**
 * AUTOCALL.KZ — кроме СМС умеет звонок с кодом (Flash Call).
 *
 * Почему это интересно именно нам: код — последние цифры номера, с
 * которого идёт звонок. Клиент ничего не платит, магазин платит меньше,
 * чем за СМС. Для сотен регистраций разница заметна.
 *
 * Запасной путь обязателен: если звонок не дошёл (клиент сбросил,
 * оператор заблокировал), отправляем обычную СМС. Клиент не должен
 * остаться без кода из-за нашей экономии.
 */
export class AutocallSmsProvider implements SmsProvider {
  readonly name = 'autocall';
  constructor(private apiKey: string, private preferCall = true) {}

  async send(phone: string, text: string): Promise<SmsResult> {
    const code = (text.match(/\b(\d{4,6})\b/) ?? [])[1];
    if (this.preferCall && code) {
      const r = await this.flashCall(phone, code);
      if (r.ok) return r;
      // не дошло — идём обычной СМС, а не оставляем клиента без кода
    }
    return this.sms(phone, text);
  }

  private async flashCall(phone: string, code: string): Promise<SmsResult> {
    try {
      const r = await fetch('https://api.autocall.kz/v1/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify({ phone: digits(phone), code }),
        signal: AbortSignal.timeout(15000),
      });
      const j: any = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, id: String(j?.id ?? ''), cost: Number(j?.cost ?? 0) }
                  : { ok: false, error: j?.message ?? `AutoCall: ${r.status}` };
    } catch (e: any) { return { ok: false, error: `AutoCall недоступен: ${e.message}` }; }
  }

  private async sms(phone: string, text: string): Promise<SmsResult> {
    try {
      const r = await fetch('https://api.autocall.kz/v1/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify({ phone: digits(phone), text }),
        signal: AbortSignal.timeout(15000),
      });
      const j: any = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, id: String(j?.id ?? '') } : { ok: false, error: j?.message ?? `AutoCall: ${r.status}` };
    } catch (e: any) { return { ok: false, error: `AutoCall недоступен: ${e.message}` }; }
  }

  async balance() {
    try {
      const r = await fetch('https://api.autocall.kz/v1/balance',
        { headers: { 'Authorization': `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(10000) });
      const j: any = await r.json().catch(() => ({}));
      return r.ok ? { amount: Number(j?.balance ?? 0), currency: 'KZT' } : null;
    } catch { return null; }
  }
}

/**
 * Выбор шлюза по настройкам. Пока ключ не задан — работает заглушка,
 * и коды по-прежнему пишутся в лог сервера. Никакой ошибки при этом
 * не возникает: регистрация не должна ломаться из-за неоплаченного СМС.
 */
export function createSmsProvider(): SmsProvider {
  const kind = process.env.SMS_PROVIDER ?? 'none';
  try {
    if (kind === 'mobizon' && process.env.SMS_API_KEY)
      return new MobizonSmsProvider(process.env.SMS_API_KEY);
    if (kind === 'smsc' && process.env.SMS_LOGIN && process.env.SMS_PASSWORD)
      return new SmscSmsProvider(process.env.SMS_LOGIN, process.env.SMS_PASSWORD, process.env.SMS_SENDER);
    if (kind === 'autocall' && process.env.SMS_API_KEY)
      return new AutocallSmsProvider(process.env.SMS_API_KEY, process.env.SMS_PREFER_CALL !== '0');
  } catch { /* настройки кривые — работаем без шлюза */ }
  return new MockSmsProvider();
}

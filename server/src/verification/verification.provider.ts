/**
 * ПРОВАЙДЕРЫ ПРОВЕРКИ КОНТРАГЕНТА (часть 34).
 *
 * Абстракция как fiscal/payment/marketplace. Портал КГД (portal.kgd.gov.kz)
 * «Сведения по контрагентам»: по БИН/ИИН → статус НДС, режим, реестр
 * неблагонадёжных, задолженность.
 *
 * ЧЕСТНО: боевой доступ к КГД — по ЭЦП/официальному API (портал требует
 * авторизацию). Здесь зафиксирована ФОРМА ответа; Mock отдаёт правдоподобные
 * данные для разных БИН, чтобы прогнать всю логику риска.
 */

export interface CounterpartyInfo {
  found: boolean;
  name?: string;
  vatPayer?: boolean;
  vatSince?: string;       // дата постановки на учёт НДС
  taxRegime?: string;      // ОУР / упрощёнка / патент / …
  isUnreliable?: boolean;  // в реестре неблагонадёжных
  hasTaxDebt?: boolean;    // есть налоговая задолженность
  error?: string;
}

export interface CounterpartyCheckProvider {
  readonly name: string;
  checkByBin(binOrIin: string): Promise<CounterpartyInfo>;
}

/**
 * MOCK — правдоподобные ответы по последней цифре БИН, чтобы прогнать все
 * ветки риска:
 *  • оканчивается на 0 → не найден
 *  • на 9 → неблагонадёжный + долг (danger)
 *  • на 8 → НЕ плательщик НДС (warning: НДС к зачёту не примут)
 *  • иначе → нормальный плательщик НДС (ok)
 */
export class MockCounterpartyCheckProvider implements CounterpartyCheckProvider {
  readonly name = 'mock';

  async checkByBin(bin: string): Promise<CounterpartyInfo> {
    const clean = (bin ?? '').replace(/\D/g, '');
    if (clean.length < 12) return { found: false, error: 'БИН/ИИН должен содержать 12 цифр' };
    const last = clean[clean.length - 1];

    if (last === '0') return { found: false };
    if (last === '9') return {
      found: true, name: 'ТОО Проблемный Поставщик', vatPayer: false,
      taxRegime: 'ОУР', isUnreliable: true, hasTaxDebt: true,
    };
    if (last === '8') return {
      found: true, name: 'ИП Малый', vatPayer: false, taxRegime: 'Упрощёнка',
      isUnreliable: false, hasTaxDebt: false,
    };
    return {
      found: true, name: 'ТОО Надёжный Партнёр', vatPayer: true, vatSince: '2020-03-15',
      taxRegime: 'ОУР', isUnreliable: false, hasTaxDebt: false,
    };
  }
}

/**
 * KGD — каркас проверки через портал КГД. Боевой запрос по ЭЦП/API мерчанта.
 */
export class KgdCounterpartyCheckProvider implements CounterpartyCheckProvider {
  readonly name = 'kgd';
  constructor(private apiUrl = 'https://portal.kgd.gov.kz') {}

  async checkByBin(bin: string): Promise<CounterpartyInfo> {
    const clean = (bin ?? '').replace(/\D/g, '');
    if (clean.length < 12) return { found: false, error: 'БИН/ИИН должен содержать 12 цифр' };
    try {
      // Портал КГД: поиск налогоплательщика по ИИН/БИН. Точный контракт — по
      // официальному сервису (требует авторизацию ЭЦП). Форма ответа ниже.
      const r = await fetch(`${this.apiUrl}/api/taxpayer?bin=${clean}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return { found: false, error: `КГД: ${r.status}` };
      const j: any = await r.json().catch(() => ({}));
      return {
        found: !!j?.found, name: j?.name, vatPayer: j?.vatPayer, vatSince: j?.vatSince,
        taxRegime: j?.taxRegime, isUnreliable: j?.isUnreliable, hasTaxDebt: j?.hasTaxDebt,
      };
    } catch (e: any) {
      return { found: false, error: `КГД недоступен: ${e.message}` };
    }
  }
}

/**
 * ПРОВЕРКА КАССЫ (ККМ) — то, что делает Wipon разделами kaspi-check и
 * kgd-check. Проверяется регистрация кассового аппарата в налоговой по
 * заводскому или регистрационному номеру.
 *
 * Зачем владельцу: касса должна быть зарегистрирована и активна. Если
 * регистрация слетела (бывает после смены оператора фискальных данных
 * или неуплаты), чеки перестают доходить в налоговую — а узнают об
 * этом обычно при проверке, когда штраф уже выписан.
 */
export interface KkmInfo {
  found: boolean;
  regNumber?: string;      // регистрационный номер в налоговой
  serial?: string;         // заводской номер
  model?: string;
  ofd?: string;            // оператор фискальных данных
  status?: string;         // active / suspended / deregistered
  registeredAt?: string;
  address?: string;        // адрес установки
  error?: string;
}

export interface KkmCheckProvider {
  readonly name: string;
  checkKkm(numberOrSerial: string): Promise<KkmInfo>;
}

/** MOCK: последняя цифра номера задаёт ответ — для прогона всех веток. */
export class MockKkmCheckProvider implements KkmCheckProvider {
  readonly name = 'mock';
  async checkKkm(num: string): Promise<KkmInfo> {
    const clean = (num ?? '').replace(/\s/g, '');
    if (clean.length < 6) return { found: false, error: 'Номер должен содержать не менее 6 знаков' };
    const last = clean[clean.length - 1];
    if (last === '0') return { found: false };
    if (last === '9') return {
      found: true, regNumber: clean, serial: 'SN' + clean, model: 'Порт-100Ф',
      ofd: 'Транстелеком', status: 'deregistered', registeredAt: '2021-04-10',
      address: 'г. Астана, ул. Абая 15',
    };
    if (last === '8') return {
      found: true, regNumber: clean, serial: 'SN' + clean, model: 'Меркурий-115Ф',
      ofd: 'Казахтелеком', status: 'suspended', registeredAt: '2022-09-01',
      address: 'г. Астана, ул. Абая 15',
    };
    return {
      found: true, regNumber: clean, serial: 'SN' + clean, model: 'АТОЛ 91Ф',
      ofd: 'Транстелеком', status: 'active', registeredAt: '2024-02-15',
      address: 'г. Астана, ул. Абая 15',
    };
  }
}

/** КГД — боевой каркас. Доступ по ЭЦП/официальному сервису. */
export class KgdKkmCheckProvider implements KkmCheckProvider {
  readonly name = 'kgd';
  constructor(private apiUrl = 'https://portal.kgd.gov.kz') {}
  async checkKkm(num: string): Promise<KkmInfo> {
    try {
      const r = await fetch(`${this.apiUrl}/api/kkm?number=${encodeURIComponent(num)}`,
        { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return { found: false, error: `КГД: ${r.status}` };
      const j: any = await r.json().catch(() => ({}));
      return { found: !!j?.found, ...j };
    } catch (e: any) {
      return { found: false, error: `Сервис КГД недоступен: ${e.message}` };
    }
  }
}

/** Что означает состояние кассы для владельца — простыми словами. */
export function assessKkm(info: KkmInfo): { level: 'ok' | 'warning' | 'danger'; reasons: string[] } {
  if (!info.found)
    return { level: 'danger', reasons: ['Касса не найдена в базе налоговой — проверьте номер'] };
  if (info.status === 'deregistered')
    return { level: 'danger', reasons: ['Касса СНЯТА С УЧЁТА — чеки не доходят в налоговую, торговать нельзя'] };
  if (info.status === 'suspended')
    return { level: 'warning', reasons: ['Регистрация приостановлена — выясните причину у оператора'] };
  return { level: 'ok', reasons: [`Зарегистрирована, оператор ${info.ofd ?? '—'}`] };
}

/** Оценка риска по данным КГД: ok / warning / danger. */
export function assessRisk(info: CounterpartyInfo): { level: 'ok' | 'warning' | 'danger'; reasons: string[] } {
  const reasons: string[] = [];
  if (!info.found) return { level: 'danger', reasons: ['Не найден в базе КГД — проверьте БИН/ИИН'] };
  if (info.isUnreliable) reasons.push('В реестре неблагонадёжных поставщиков');
  if (info.hasTaxDebt) reasons.push('Есть налоговая задолженность');
  if (info.vatPayer === false) reasons.push('Не плательщик НДС — НДС к зачёту не примут');
  if (info.isUnreliable) return { level: 'danger', reasons };
  if (reasons.length) return { level: 'warning', reasons };
  return { level: 'ok', reasons: ['Плательщик НДС, без долгов и ограничений'] };
}

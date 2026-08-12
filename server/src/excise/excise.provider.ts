/**
 * ПРОВАЙДЕРЫ ПРОВЕРКИ УКМ (часть 36) — акцизные марки алкоголя.
 *
 * Проверка подлинности УКМ через e-Sapa (КГД РК + НИТ) или портал КГД
 * «Проверка достоверности УКМ». По серии+номеру или скану штрих-кода.
 * Результат: «Код присутствует в базе» + инфо (название, вид, объём, крепость,
 * поставщик), либо «УКМ не найдена».
 *
 * ЧЕСТНО: боевой доступ к e-Sapa/КГД — по ЭЦП НУЦ РК. Здесь зафиксирована
 * ФОРМА ответа; Mock отдаёт правдоподобные данные для прогона логики.
 */

export interface UkmInfo {
  found: boolean;
  productName?: string;
  kind?: string;         // водка / коньяк / вино / …
  volume?: number;       // объём тары, л
  strength?: number;     // крепость, %
  producer?: string;
  error?: string;
}

export interface ExciseCheckProvider {
  readonly name: string;
  /** Проверить УКМ по серии и номеру */
  check(series: string, number: string): Promise<UkmInfo>;
  /** Разобрать штрих-код УКМ на серию+номер (PDF417/DataMatrix) */
  parseBarcode(code: string): { series: string; number: string } | null;
}

/**
 * MOCK — правдоподобные ответы. Управление по последней цифре номера:
 *  • оканчивается на 0 → не найдена (контрафакт)
 *  • иначе → подлинная марка с данными о продукте
 */
export class MockExciseCheckProvider implements ExciseCheckProvider {
  readonly name = 'mock';

  async check(series: string, number: string): Promise<UkmInfo> {
    if (!series || !number) return { found: false, error: 'Нужны серия и номер УКМ' };
    const last = number[number.length - 1];
    if (last === '0') return { found: false };
    return {
      found: true, productName: 'Водка «Тест» 0.5л', kind: 'водка',
      volume: 0.5, strength: 40, producer: 'ТОО Ликёро-водочный завод',
    };
  }

  /** УКМ штрих-код: «AA0000000001» → серия AA (2 буквы) + номер (остальное) */
  parseBarcode(code: string): { series: string; number: string } | null {
    const clean = (code ?? '').trim().toUpperCase();
    const m = clean.match(/^([A-ZА-Я]{2})[\s-]?(\d{6,12})$/);
    if (!m) return null;
    return { series: m[1], number: m[2] };
  }
}

/**
 * E-SAPA / КГД — каркас проверки через официальный сервис. Боевой доступ по
 * ЭЦП НУЦ РК.
 */
export class EsapaExciseCheckProvider implements ExciseCheckProvider {
  readonly name = 'esapa';
  constructor(private apiUrl = 'https://portal.kgd.gov.kz') {}

  async check(series: string, number: string): Promise<UkmInfo> {
    if (!series || !number) return { found: false, error: 'Нужны серия и номер УКМ' };
    try {
      const r = await fetch(`${this.apiUrl}/api/ukm?series=${encodeURIComponent(series)}&number=${encodeURIComponent(number)}`,
        { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return { found: false, error: `КГД: ${r.status}` };
      const j: any = await r.json().catch(() => ({}));
      return {
        found: !!j?.found, productName: j?.productName, kind: j?.kind,
        volume: j?.volume, strength: j?.strength, producer: j?.producer,
      };
    } catch (e: any) {
      return { found: false, error: `Сервис УКМ недоступен: ${e.message}` };
    }
  }

  parseBarcode(code: string): { series: string; number: string } | null {
    // тот же формат серии+номера; боевой парсинг PDF417 — на стороне сканера
    const clean = (code ?? '').trim().toUpperCase();
    const m = clean.match(/^([A-ZА-Я]{2})[\s-]?(\d{6,12})$/);
    if (!m) return null;
    return { series: m[1], number: m[2] };
  }
}

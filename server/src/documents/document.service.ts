import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * ДОКУМЕНТЫ КАЗАХСТАНА.
 *
 * Единственный эталон здесь — Wipon: у UMAG документов КЗ нет вообще,
 * у МоегоСклада конструктор форм и российская маркировка.
 *
 * Главное отличие: у Wipon ЭСФ создаётся вручную («Нажать на + … Заполнить
 * все необходимые поля»). У нас ЭСФ рождается из приёмки или продажи —
 * контрагент, позиции, суммы и НДС уже в системе. Владелец проверяет, а не
 * набивает второй раз то, что уже ввёл.
 *
 * ЧЕСТНО о границе: ЭЦП выдаёт НУЦ РК живому человеку, доступ к ИС ЭСФ
 * заводится на портале, внешние домены в этой среде закрыты. Поэтому обмен с
 * порталом устроен так же, как операторы фискализации в Части 5: форма
 * зафиксирована, тела запросов заполняются по договору и доступу.
 */

export interface EsfProvider {
  readonly name: string;
  send(key: any, doc: any, items: any[]): Promise<{ ok: boolean; govNumber?: string; govId?: string; error?: string; retryable?: boolean; raw?: any }>;
  revoke?(key: any, doc: any, reason: string): Promise<{ ok: boolean; error?: string }>;
  fetchIncoming?(key: any, from: string, to: string): Promise<any[]>;
}

/**
 * ИС ЭСФ (esf.gov.kz).
 *
 * ЧЕСТНО, как и с WebKassa в Части 5: точного контракта их API у меня нет —
 * доступ выдаётся по договору и ЭЦП, внешние домены здесь закрыты. Придумать
 * структуру запросов и выдать за проверенную нельзя.
 *
 * Что уже работает и не зависит от контракта: сборка документа из наших
 * данных, очередь, повторы, идемпотентность, контроль срока ключа. Подключить
 * реальные вызовы — работа на день-два, когда есть доступ.
 */
export class IsEsfProvider implements EsfProvider {
  readonly name = 'is_esf';
  private log = new Logger('IsEsf');

  async send(key: any, doc: any, items: any[]) {
    if (!key?.key_data) return { ok: false, error: 'Не привязан ключ ЭЦП', retryable: false };
    if (key.valid_until && new Date(key.valid_until) < new Date())
      return { ok: false, error: 'Ключ ЭЦП просрочен', retryable: false };

    this.log.warn(`ЭСФ ${doc.number}: контракт ИС ЭСФ не подключён — нужен доступ к порталу`);
    return {
      ok: false,
      error: 'Обмен с ИС ЭСФ не настроен: нужен доступ к порталу esf.gov.kz и договор',
      retryable: false,
    };
  }
}

/** Симулятор портала для проверки логики: очередь, повторы, отзыв. */
export class MockEsfProvider implements EsfProvider {
  readonly name = 'mock';
  failNext = 0;
  failPermanently = false;
  sent: any[] = [];
  private counter = 1;

  async send(key: any, doc: any, items: any[]) {
    if (!key?.key_data) return { ok: false, error: 'Не привязан ключ ЭЦП', retryable: false };
    if (key.valid_until && new Date(key.valid_until) < new Date())
      return { ok: false, error: 'Ключ ЭЦП просрочен', retryable: false };
    if (this.failPermanently) return { ok: false, error: 'БИН получателя не найден в реестре', retryable: false };
    if (this.failNext > 0) { this.failNext--; return { ok: false, error: 'Портал ИС ЭСФ недоступен', retryable: true }; }

    // портал сам проверяет обязательные поля — повторяем эти проверки
    if (!items.length) return { ok: false, error: 'В документе нет позиций', retryable: false };
    if (items.some((i) => !i.ntin)) return { ok: false, error: 'У позиции не указан код НКТ', retryable: false };

    const govNumber = `ESF-${new Date().getFullYear()}-${String(this.counter++).padStart(6, '0')}`;
    this.sent.push({ number: doc.number, govNumber, items: items.length });
    return { ok: true, govNumber, govId: `${Date.now()}`, raw: { registered: true } };
  }

  async revoke(key: any, doc: any, reason: string) {
    if (!doc.gov_number) return { ok: false, error: 'Документ не был отправлен' };
    return { ok: true };
  }
}

@Injectable()
export class DocumentService {
  private log = new Logger('Documents');
  private providers = new Map<string, EsfProvider>([['is_esf', new IsEsfProvider()]]);

  constructor(private db: DbService) {}

  registerProvider(name: string, p: EsfProvider) { this.providers.set(name, p); }
  private impl(name?: string) { return this.providers.get(name ?? 'is_esf') ?? this.providers.get('is_esf')!; }

  // ==================================================================
  // ЭЦП
  // ==================================================================
  async addKey(accountId: string, dto: {
    name: string; keyData: Buffer | string; keyPassword?: string; storePassword?: boolean;
    esfLogin?: string; esfPassword?: string; subjectBin?: string; subjectName?: string;
    validFrom?: string; validUntil?: string; organizationId?: string;
  }) {
    const secret = process.env.SECRET_KEY ?? 'dev_key_change_me';
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO gov_key (account_id, organization_id, name, key_data, key_password_enc, store_password,
                              esf_login, esf_password_enc, subject_bin, subject_name, valid_from, valid_until)
         VALUES ($1,$2,$3, pgp_sym_encrypt_bytea($4::bytea, $5),
                 CASE WHEN $6::boolean THEN pgp_sym_encrypt($7, $5) ELSE NULL END, $6,
                 $8, CASE WHEN $9::text IS NOT NULL THEN pgp_sym_encrypt($9, $5) ELSE NULL END,
                 $10, $11, $12::timestamptz, $13::timestamptz)
         RETURNING id, name, subject_bin, valid_until, store_password`,
        [accountId, dto.organizationId ?? null, dto.name,
         typeof dto.keyData === 'string' ? Buffer.from(dto.keyData, 'base64') : dto.keyData, secret,
         dto.storePassword ?? false, dto.keyPassword ?? null,
         dto.esfLogin ?? null, dto.esfPassword ?? null,
         dto.subjectBin ?? null, dto.subjectName ?? null,
         dto.validFrom ?? null, dto.validUntil ?? null]);
      return {
        ...rows[0],
        // не молчим о том, что храним пароль от ключа подписи
        warning: dto.storePassword
          ? 'Пароль от ключа сохранён в системе. Это удобно, но безопаснее вводить его при каждой отправке'
          : undefined,
      };
    });
  }

  /** Срок ключа: просроченный ЭЦП — это невыписанный ЭСФ, а срок выписки ограничен. */
  async keyHealth(accountId: string) {
    const { rows } = await this.db.raw(`SELECT * FROM gov_key_health($1)`, [accountId]);
    return rows.map((r: any) => ({
      keyId: r.key_id, name: r.name, subjectBin: r.subject_bin,
      validUntil: r.valid_until, daysLeft: r.days_left, status: r.status, message: r.message,
    }));
  }

  private async loadKey(c: any, accountId: string, keyId?: string) {
    const secret = process.env.SECRET_KEY ?? 'dev_key_change_me';
    const r = (await c.query(
      `SELECT id, name, subject_bin, valid_until, store_password, esf_login,
              pgp_sym_decrypt_bytea(key_data, $2) AS key_data,
              CASE WHEN store_password THEN pgp_sym_decrypt(key_password_enc, $2) END AS key_password,
              CASE WHEN esf_password_enc IS NOT NULL THEN pgp_sym_decrypt(esf_password_enc, $2) END AS esf_password
         FROM gov_key
        WHERE account_id = $3 AND is_active AND deleted_at IS NULL
          AND ($1::uuid IS NULL OR id = $1)
        ORDER BY valid_until DESC NULLS LAST LIMIT 1`, [keyId ?? null, secret, accountId])).rows[0];
    return r;
  }

  // ==================================================================
  // 9.1 ЭСФ — выписывается ИЗ документа
  // ==================================================================

  /** ЭСФ по приёмке: поставщик и позиции уже известны. */
  async esfFromSupply(accountId: string, stockDocId: string, employeeId?: string) {
    return this.db.withTenant(accountId, async (c) => {
      const d = (await c.query(
        `SELECT d.*, c.name AS supplier, c.iin_bin FROM stock_doc d
           LEFT JOIN counterparty c ON c.id = d.supplier_id
          WHERE d.id=$1 AND d.kind='supply'`, [stockDocId])).rows[0];
      if (!d) throw new BadRequestException('Приёмка не найдена');
      if (d.status !== 'done') throw new BadRequestException('ЭСФ выписывается по проведённой приёмке');
      if (!d.supplier_id) throw new BadRequestException('У приёмки не указан поставщик — ЭСФ выписать не на кого');

      const items = (await c.query(
        `SELECT i.*, p.name, p.ntin, u.short_name AS unit FROM stock_doc_item i
           JOIN product p ON p.id = i.product_id
           LEFT JOIN unit u ON u.id = p.unit_id
          WHERE i.doc_id=$1 ORDER BY i.seq`, [stockDocId])).rows;

      return this.createEsf(c, accountId, {
        direction: 'received', counterpartyId: d.supplier_id, docId: stockDocId,
        employeeId, turnoverDate: d.processed_at,
        items: items.map((i: any) => ({
          productId: i.product_id, name: i.name, ntin: i.ntin, unit: i.unit,
          qty: Number(i.qty), price: Number(i.price ?? 0), vatRate: 12,
        })),
      });
    });
  }

  /** ЭСФ по продаже юрлицу: покупатель и позиции уже в чеке. */
  async esfFromSale(accountId: string, saleId: string, employeeId?: string) {
    return this.db.withTenant(accountId, async (c) => {
      const s = (await c.query(
        `SELECT s.*, c.name AS customer, c.iin_bin FROM sale s
           LEFT JOIN counterparty c ON c.id = s.customer_id
          WHERE s.id=$1 AND s.status IN ('completed','returned')`, [saleId])).rows[0];
      if (!s) throw new BadRequestException('Чек не найден или не пробит');
      if (!s.customer_id) throw new BadRequestException('В чеке не указан покупатель — ЭСФ выписывается юрлицу');
      if (!s.iin_bin) throw new BadRequestException(`У «${s.customer}» не указан ИИН/БИН — без него ЭСФ не примут`);

      const items = (await c.query(
        `SELECT i.*, p.name, p.ntin, u.short_name AS unit FROM sale_item i
           JOIN product p ON p.id = i.product_id
           LEFT JOIN unit u ON u.id = p.unit_id
          WHERE i.sale_id=$1 ORDER BY i.seq`, [saleId])).rows;

      return this.createEsf(c, accountId, {
        direction: 'issued', counterpartyId: s.customer_id, saleId,
        employeeId, turnoverDate: s.completed_at,
        items: items.map((i: any) => ({
          productId: i.product_id, name: i.name, ntin: i.ntin, unit: i.unit,
          qty: Number(i.qty), price: Number(i.price), vatRate: Number(i.vat_rate ?? 12),
          discount: Number(i.discount_sum ?? 0),
        })),
      });
    });
  }

  private async createEsf(c: any, accountId: string, dto: any) {
    const num = (await c.query(`SELECT next_gov_number($1,'esf') AS n`, [accountId])).rows[0].n;
    const org = (await c.query(
      `SELECT id FROM organization WHERE deleted_at IS NULL ORDER BY is_default DESC LIMIT 1`)).rows[0];

    let total = 0, vatTotal = 0;
    const lines = dto.items.map((it: any, idx: number) => {
      const gross = Math.round((it.qty * it.price - (it.discount ?? 0)) * 100) / 100;
      const rate = Number(it.vatRate ?? 12);
      // в РК цена включает НДС: выделяем его обратным счётом
      const woVat = Math.round((gross / (1 + rate / 100)) * 100) / 100;
      const vat = Math.round((gross - woVat) * 100) / 100;
      total += gross; vatTotal += vat;
      return { ...it, lineNo: idx + 1, totalWoVat: woVat, vatSum: vat, totalWithVat: gross };
    });

    const { rows } = await c.query(
      `INSERT INTO gov_doc (account_id, organization_id, kind, direction, number, counterparty_id,
                            sale_id, doc_id, turnover_date, total_sum, vat_sum, employee_id, payload)
       VALUES ($1,$2,'esf',$3::esf_direction,$4,$5,$6,$7,$8::date,$9::numeric,$10::numeric,$11,$12)
       ON CONFLICT DO NOTHING RETURNING *`,
      [accountId, org?.id ?? null, dto.direction, String(num), dto.counterpartyId,
       dto.saleId ?? null, dto.docId ?? null, dto.turnoverDate, Math.round(total * 100) / 100,
       Math.round(vatTotal * 100) / 100, dto.employeeId ?? null, JSON.stringify({ source: dto.saleId ? 'sale' : 'supply' })]);

    if (!rows[0]) throw new BadRequestException('ЭСФ по этому документу уже выписан');

    for (const l of lines) {
      await c.query(
        `INSERT INTO gov_doc_item (account_id, gov_doc_id, line_no, product_id, name, ntin, unit_code,
                                   qty, price, total_wo_vat, vat_rate, vat_sum, total_with_vat)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10::numeric,$11::numeric,$12::numeric,$13::numeric)`,
        [accountId, rows[0].id, l.lineNo, l.productId ?? null, l.name, l.ntin ?? null, l.unit ?? null,
         l.qty, l.price, l.totalWoVat, l.vatRate, l.vatSum, l.totalWithVat]);
    }

    const noNtin = lines.filter((l: any) => !l.ntin).map((l: any) => l.name);
    return {
      id: rows[0].id, number: rows[0].number, status: rows[0].status,
      total: Number(rows[0].total_sum), vat: Number(rows[0].vat_sum), items: lines.length,
      // предупреждаем ДО отправки: портал отклонит, и владелец не поймёт почему
      warnings: noNtin.length ? [`Без кода НКТ: ${noNtin.join(', ')} — ИС ЭСФ такой документ не примет`] : [],
    };
  }

  /** Отправка в ОГД. Очередь и повторы — как в фискализации: портал ложится. */
  async sendDoc(accountId: string, govDocId: string, keyId?: string) {
    return this.db.withTenant(accountId, async (c) => {
      const doc = (await c.query(`SELECT * FROM gov_doc WHERE id=$1 AND deleted_at IS NULL`, [govDocId])).rows[0];
      if (!doc) throw new BadRequestException('Документ не найден');
      if (doc.status === 'sent' || doc.status === 'delivered')
        return { sent: false, reason: `Документ уже в ОГД под номером ${doc.gov_number}` };

      const key = await this.loadKey(c, accountId, keyId);
      if (!key) throw new BadRequestException('Не привязан ключ ЭЦП — добавьте его в разделе документов');

      const items = (await c.query(`SELECT * FROM gov_doc_item WHERE gov_doc_id=$1 ORDER BY line_no`, [govDocId])).rows;
      const provider = this.impl(doc.payload?.provider);

      await c.query(`UPDATE gov_doc SET status='sending', attempts=attempts+1 WHERE id=$1`, [govDocId]);
      const r = await provider.send(key, doc, items);

      if (r.ok) {
        await c.query(
          `UPDATE gov_doc SET status='sent', gov_number=$2, gov_id=$3, sent_at=now(),
                  gov_response=$4, last_error=NULL, next_try_at=NULL WHERE id=$1`,
          [govDocId, r.govNumber, r.govId ?? null, JSON.stringify(r.raw ?? {})]);
        await c.query(`UPDATE gov_key SET last_used_at=now(), last_error=NULL WHERE id=$1`, [key.id]);
        return { sent: true, govNumber: r.govNumber };
      }

      // растущий отступ: портал ИС ЭСФ ложится в конце месяца, долбить его бесполезно
      const attempts = Number(doc.attempts) + 1;
      const backoff = Math.min(2 ** attempts, 600);
      await c.query(
        `UPDATE gov_doc SET status=$2::gov_doc_status, last_error=$3,
                next_try_at = CASE WHEN $4::boolean THEN now() + ($5 || ' seconds')::interval END
          WHERE id=$1`,
        [govDocId, r.retryable ? 'sending' : 'rejected', r.error ?? null, r.retryable ?? false, backoff]);
      return { sent: false, reason: r.error, retryable: r.retryable ?? false };
    });
  }

  /** Обработка очереди: портал ожил — документы уехали. */
  async processQueue(accountId: string, limit = 20) {
    const jobs = await this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT id FROM gov_doc WHERE status='sending' AND (next_try_at IS NULL OR next_try_at <= now())
            AND deleted_at IS NULL ORDER BY issue_date LIMIT $1`, [limit])).rows);
    let sent = 0, failed = 0;
    for (const j of jobs) {
      const r = await this.sendDoc(accountId, j.id).catch(() => ({ sent: false }));
      r.sent ? sent++ : failed++;
    }
    return { processed: jobs.length, sent, failed };
  }

  /** Отзыв документа (действие «Отозвать» у Wipon). */
  async revokeDoc(accountId: string, govDocId: string, reason: string, keyId?: string) {
    if (!reason?.trim()) throw new BadRequestException('Причина отзыва обязательна');
    return this.db.withTenant(accountId, async (c) => {
      const doc = (await c.query(`SELECT * FROM gov_doc WHERE id=$1`, [govDocId])).rows[0];
      if (!doc) throw new BadRequestException('Документ не найден');
      if (!['sent', 'delivered'].includes(doc.status))
        throw new BadRequestException('Отозвать можно только отправленный документ');

      const key = await this.loadKey(c, accountId, keyId);
      const provider = this.impl(doc.payload?.provider);
      const r = provider.revoke ? await provider.revoke(key, doc, reason) : { ok: false, error: 'Оператор не умеет отзывать' };
      if (!r.ok) throw new BadRequestException(r.error ?? 'Не удалось отозвать');

      await c.query(
        `UPDATE gov_doc SET status='revoked', revoked_at=now(), revoke_reason=$2 WHERE id=$1`,
        [govDocId, reason]);
      return { revoked: true };
    });
  }

  async list(accountId: string, f: { kind?: string; status?: string; counterpartyId?: string; from?: string; to?: string; limit?: number } = {}) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT d.id, d.kind, d.direction, d.status, d.number, d.gov_number, d.issue_date,
                d.total_sum, d.vat_sum, d.last_error, c.name AS counterparty, c.iin_bin
           FROM gov_doc d LEFT JOIN counterparty c ON c.id = d.counterparty_id
          WHERE d.deleted_at IS NULL
            AND ($1::text IS NULL OR d.kind::text = $1)
            AND ($2::text IS NULL OR d.status::text = $2)
            AND ($3::uuid IS NULL OR d.counterparty_id = $3)
            AND ($4::date IS NULL OR d.issue_date >= $4)
            AND ($5::date IS NULL OR d.issue_date <= $5)
          ORDER BY d.issue_date DESC, d.seq DESC LIMIT $6`,
        [f.kind ?? null, f.status ?? null, f.counterpartyId ?? null, f.from ?? null, f.to ?? null, f.limit ?? 100])).rows
        .map((r: any) => ({ ...r, total_sum: Number(r.total_sum), vat_sum: Number(r.vat_sum) })));
  }

  // ==================================================================
  // 9.2 СНТ, 9.3 АВР, 9.4 ДОВЕРЕННОСТИ
  // ==================================================================

  /** АВР — акт выполненных работ (для услуг). */
  async createAvr(accountId: string, dto: {
    counterpartyId: string; items: { name: string; qty: number; price: number; vatRate?: number }[];
    employeeId?: string; comment?: string;
  }) {
    if (!dto.items?.length) throw new BadRequestException('В акте нет позиций');
    return this.db.withTenant(accountId, async (c) => {
      const num = (await c.query(`SELECT next_gov_number($1,'avr') AS n`, [accountId])).rows[0].n;
      const org = (await c.query(`SELECT id FROM organization WHERE deleted_at IS NULL ORDER BY is_default DESC LIMIT 1`)).rows[0];

      let total = 0, vatTotal = 0;
      const lines = dto.items.map((it, idx) => {
        const gross = Math.round(it.qty * it.price * 100) / 100;
        const rate = Number(it.vatRate ?? 12);
        const woVat = Math.round((gross / (1 + rate / 100)) * 100) / 100;
        const vat = Math.round((gross - woVat) * 100) / 100;
        total += gross; vatTotal += vat;
        return { ...it, lineNo: idx + 1, totalWoVat: woVat, vatSum: vat, totalWithVat: gross, vatRate: rate };
      });

      const { rows } = await c.query(
        `INSERT INTO gov_doc (account_id, organization_id, kind, number, counterparty_id, employee_id,
                              total_sum, vat_sum, comment)
         VALUES ($1,$2,'avr',$3,$4,$5,$6::numeric,$7::numeric,$8) RETURNING *`,
        [accountId, org?.id ?? null, String(num), dto.counterpartyId, dto.employeeId ?? null,
         Math.round(total * 100) / 100, Math.round(vatTotal * 100) / 100, dto.comment ?? null]);

      for (const l of lines)
        await c.query(
          `INSERT INTO gov_doc_item (account_id, gov_doc_id, line_no, name, qty, price,
                                     total_wo_vat, vat_rate, vat_sum, total_with_vat)
           VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7::numeric,$8::numeric,$9::numeric,$10::numeric)`,
          [accountId, rows[0].id, l.lineNo, l.name, l.qty, l.price, l.totalWoVat, l.vatRate, l.vatSum, l.totalWithVat]);

      return { id: rows[0].id, number: rows[0].number, total: Number(rows[0].total_sum), items: lines.length };
    });
  }

  /**
   * Доверенность (модель Wipon: склад, сотрудник, поставщик, дата, счёт-основание,
   * затем ожидание подписания).
   */
  async createPoa(accountId: string, dto: {
    counterpartyId: string; employeeId: string; warehouseId?: string;
    validUntil?: string; basis?: string; items?: { name: string; qty: number; unit?: string }[];
  }) {
    return this.db.withTenant(accountId, async (c) => {
      const emp = (await c.query(
        `SELECT first_name, last_name, position, iin, id_doc_number, id_doc_issued_by, id_doc_issued_at
           FROM employee WHERE id=$1`, [dto.employeeId])).rows[0];
      if (!emp) throw new BadRequestException('Сотрудник не найден');
      const num = (await c.query(`SELECT next_gov_number($1,'poa') AS n`, [accountId])).rows[0].n;
      const org = (await c.query(`SELECT id FROM organization WHERE deleted_at IS NULL ORDER BY is_default DESC LIMIT 1`)).rows[0];

      const { rows } = await c.query(
        `INSERT INTO gov_doc (account_id, organization_id, kind, number, counterparty_id, employee_id, payload, comment)
         VALUES ($1,$2,'poa',$3,$4,$5,$6,$7) RETURNING *`,
        [accountId, org?.id ?? null, String(num), dto.counterpartyId, dto.employeeId,
         JSON.stringify({
           warehouseId: dto.warehouseId, validUntil: dto.validUntil, basis: dto.basis,
           employee: `${emp.first_name} ${emp.last_name ?? ''}`.trim(), position: emp.position,
           iin: emp.iin, idDoc: emp.id_doc_number, idDocIssuedBy: emp.id_doc_issued_by,
           idDocIssuedAt: emp.id_doc_issued_at,
         }),
         dto.basis ?? null]);

      for (const [idx, it] of (dto.items ?? []).entries())
        await c.query(
          `INSERT INTO gov_doc_item (account_id, gov_doc_id, line_no, name, qty, price,
                                     total_wo_vat, total_with_vat, unit_code)
           VALUES ($1,$2,$3,$4,$5::numeric,0,0,0,$6)`,
          [accountId, rows[0].id, idx + 1, it.name, it.qty, it.unit ?? null]);

      return {
        id: rows[0].id, number: rows[0].number, status: rows[0].status,
        employee: `${emp.first_name} ${emp.last_name ?? ''}`.trim(),
        // без ИИН и удостоверения поставщик товар не отдаст: доверенность М-2
        // требует их прямо в бланке
        warnings: [
          ...(emp.iin ? [] : ['У сотрудника не указан ИИН — в доверенности это обязательное поле']),
          ...(emp.id_doc_number ? [] : ['Не указано удостоверение личности — поставщик может не принять доверенность']),
        ],
        note: 'Доверенность сформирована. Дальше — подписание контрагентом',
      };
    });
  }

  // ==================================================================
  // 9.5 ПЕЧАТНЫЕ ФОРМЫ КАЗАХСТАНА
  // Готовый набор, без конструктора МоегоСклада (511 шаблонов):
  // магазину у дома нужны формы, а не язык шаблонов.
  // ==================================================================
  async printForm(accountId: string, form: 'invoice' | 'esf' | 'waybill' | 'poa' | 'avr' | 'payment_order', sourceId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const org = (await c.query(
        `SELECT * FROM organization WHERE deleted_at IS NULL ORDER BY is_default DESC LIMIT 1`)).rows[0];
      if (!org) throw new BadRequestException('Не заполнены реквизиты организации');

      const head = {
        org: {
          name: org.name, shortName: org.short_name, tin: org.tin, address: org.address,
          phone: org.phone, bankName: org.bank_name, bankBic: org.bank_bic, bankAccount: org.bank_account,
          director: org.director_name, accountant: org.accountant_name,
          // правка логотипа, печати и подписи — вместо конструктора форм
          stampUrl: org.stamp_url, signatureUrl: org.signature_url,
        },
      };

      if (form === 'esf' || form === 'avr' || form === 'poa') {
        const d = (await c.query(
          `SELECT d.*, c.name AS cp_name, c.iin_bin AS cp_bin, c.legal_address AS cp_address,
                  c.director AS cp_director
             FROM gov_doc d LEFT JOIN counterparty c ON c.id = d.counterparty_id WHERE d.id=$1`, [sourceId])).rows[0];
        if (!d) throw new BadRequestException('Документ не найден');
        const items = (await c.query(`SELECT * FROM gov_doc_item WHERE gov_doc_id=$1 ORDER BY line_no`, [sourceId])).rows;
        return {
          form, ...head,
          doc: {
            number: d.number, govNumber: d.gov_number, date: d.issue_date, status: d.status,
            total: Number(d.total_sum), vat: Number(d.vat_sum), payload: d.payload,
          },
          counterparty: { name: d.cp_name, bin: d.cp_bin, address: d.cp_address, director: d.cp_director },
          items: items.map((i: any) => ({
            lineNo: i.line_no, name: i.name, ntin: i.ntin, unit: i.unit_code,
            qty: Number(i.qty), price: Number(i.price),
            totalWoVat: Number(i.total_wo_vat), vatRate: Number(i.vat_rate ?? 0),
            vatSum: Number(i.vat_sum), total: Number(i.total_with_vat),
          })),
          totalInWords: amountInWords(Number(d.total_sum)),
        };
      }

      if (form === 'waybill') {
        const d = (await c.query(
          `SELECT d.*, c.name AS cp_name, c.iin_bin AS cp_bin, w.name AS warehouse
             FROM stock_doc d LEFT JOIN counterparty c ON c.id = d.supplier_id
             LEFT JOIN warehouse w ON w.id = d.warehouse_id WHERE d.id=$1`, [sourceId])).rows[0];
        if (!d) throw new BadRequestException('Документ не найден');
        const items = (await c.query(
          `SELECT i.*, p.name, u.short_name AS unit FROM stock_doc_item i
             JOIN product p ON p.id = i.product_id LEFT JOIN unit u ON u.id = p.unit_id
            WHERE i.doc_id=$1 ORDER BY i.seq`, [sourceId])).rows;
        return {
          form, ...head,
          doc: { number: d.number, date: d.processed_at ?? d.created_at, total: Number(d.total_sum), warehouse: d.warehouse },
          counterparty: { name: d.cp_name, bin: d.cp_bin },
          items: items.map((i: any, n: number) => ({
            lineNo: n + 1, name: i.name, unit: i.unit, qty: Number(i.qty),
            price: Number(i.price ?? 0), total: Math.round(Number(i.qty) * Number(i.price ?? 0) * 100) / 100,
          })),
          totalInWords: amountInWords(Number(d.total_sum)),
        };
      }

      // счёт на оплату и платёжное поручение — по чеку
      const s = (await c.query(
        `SELECT s.*, c.name AS cp_name, c.iin_bin AS cp_bin FROM sale s
           LEFT JOIN counterparty c ON c.id = s.customer_id WHERE s.id=$1`, [sourceId])).rows[0];
      if (!s) throw new BadRequestException('Чек не найден');
      const items = (await c.query(
        `SELECT i.*, p.name, u.short_name AS unit FROM sale_item i
           JOIN product p ON p.id = i.product_id LEFT JOIN unit u ON u.id = p.unit_id
          WHERE i.sale_id=$1`, [sourceId])).rows;
      return {
        form, ...head,
        doc: { number: s.number, date: s.completed_at, total: Number(s.total) },
        counterparty: { name: s.cp_name, bin: s.cp_bin },
        items: items.map((i: any, n: number) => ({
          lineNo: n + 1, name: i.name, unit: i.unit, qty: Number(i.qty),
          price: Number(i.price), total: Number(i.total),
        })),
        totalInWords: amountInWords(Number(s.total)),
      };
    });
  }

  // ==================================================================
  // МАРКИРОВКА (Data Matrix). У Wipon Ismet «в разработке».
  // ==================================================================

  /** Разбор кода Data Matrix: GTIN и серийный номер. */
  parseDataMatrix(code: string) {
    // формат GS1: 01 <14 цифр GTIN> 21 <серийный номер>
    const m = code.match(/^01(\d{14})21([^\u001d]{1,20})/);
    if (!m) return { valid: false, reason: 'Код не похож на Data Matrix формата GS1' };
    return { valid: true, gtin: m[1], serial: m[2], code };
  }

  /** Приём маркированного товара: коды ложатся на склад. */
  async receiveMarkedCodes(accountId: string, dto: { docId: string; productId: string; codes: string[] }) {
    return this.db.withTenant(accountId, async (c) => {
      const accepted: string[] = [], rejected: any[] = [];
      for (const raw of dto.codes) {
        const p = this.parseDataMatrix(raw);
        if (!p.valid) { rejected.push({ code: raw, reason: p.reason }); continue; }
        const dup = (await c.query(`SELECT id, status FROM marking_code WHERE code=$1`, [raw])).rows[0];
        if (dup) { rejected.push({ code: raw, reason: `Код уже в системе (${dup.status})` }); continue; }
        await c.query(
          `INSERT INTO marking_code (account_id, code, gtin, serial, product_id, doc_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [accountId, raw, p.gtin, p.serial, dto.productId, dto.docId]);
        accepted.push(raw);
      }
      return { accepted: accepted.length, rejected };
    });
  }

  /** Продажа маркированного товара: код выводится из оборота. */
  async sellMarkedCode(accountId: string, dto: { code: string; saleId: string; productId?: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const mc = (await c.query(`SELECT * FROM marking_code WHERE code=$1`, [dto.code])).rows[0];
      if (!mc) throw new BadRequestException('Код маркировки не найден на складе — товар не принимали');
      if (mc.status === 'sold') throw new BadRequestException('Этот код уже продан: повторная продажа маркированного товара запрещена');
      if (dto.productId && mc.product_id !== dto.productId)
        throw new BadRequestException('Код маркировки от другого товара');

      await c.query(
        `UPDATE marking_code SET status='sold', sale_id=$2, sold_at=now() WHERE id=$1`, [mc.id, dto.saleId]);
      return {
        ok: true, gtin: mc.gtin, serial: mc.serial,
        // сообщение в ИС МПТ — по той же схеме, что ЭСФ: нужен доступ
        note: 'Код помечен как проданный. Вывод из оборота уйдёт в ИС МПТ при настроенном обмене',
      };
    });
  }

  // ==================================================================
  // НАЛОГОВЫЕ РЕГИСТРЫ (список Wipon)
  // ==================================================================
  async taxRegisterIncome(accountId: string, from: string, to: string) {
    const { rows } = await this.db.raw(`SELECT * FROM tax_register_income($1,$2::date,$3::date)`, [accountId, from, to]);
    const items = rows.map((r: any) => ({
      day: r.day, receipts: r.receipts, total: Number(r.total),
      cash: Number(r.cash), cashless: Number(r.cashless), credit: Number(r.credit),
    }));
    return {
      period: { from, to }, items,
      total: items.reduce((s: number, i: any) => s + i.total, 0),
      // безнал отдельной строкой: в РК его спрашивают в первую очередь
      totalCashless: items.reduce((s: number, i: any) => s + i.cashless, 0),
      totalCash: items.reduce((s: number, i: any) => s + i.cash, 0),
    };
  }

  async taxRegisterPurchases(accountId: string, from: string, to: string) {
    const { rows } = await this.db.raw(`SELECT * FROM tax_register_purchases($1,$2::date,$3::date)`, [accountId, from, to]);
    const items = rows.map((r: any) => ({
      date: r.doc_date, docNumber: r.doc_number, supplier: r.supplier,
      supplierBin: r.supplier_bin, total: Number(r.total), esfNumber: r.esf_number,
    }));
    return {
      period: { from, to }, items,
      total: items.reduce((s: number, i: any) => s + i.total, 0),
      // закупка без ЭСФ — это незачтённый НДС и вопрос при проверке
      withoutEsf: items.filter((i: any) => !i.esfNumber).length,
    };
  }
}

/** Сумма прописью: обязательный реквизит казахстанских форм. */
export function amountInWords(v: number): string {
  const units = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const unitsF = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
                 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
  const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

  const trio = (n: number, female = false) => {
    const out: string[] = [];
    if (n >= 100) out.push(hundreds[Math.floor(n / 100)]);
    const r = n % 100;
    if (r >= 10 && r < 20) out.push(teens[r - 10]);
    else {
      if (r >= 20) out.push(tens[Math.floor(r / 10)]);
      const u = r % 10;
      if (u) out.push(female ? unitsF[u] : units[u]);
    }
    return out.join(' ');
  };
  const plural = (n: number, forms: [string, string, string]) => {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
    return forms[2];
  };

  const whole = Math.floor(Math.abs(v));
  const coins = Math.round((Math.abs(v) - whole) * 100);
  if (whole === 0 && coins === 0) return 'ноль тенге 00 тиын';

  const parts: string[] = [];
  const mil = Math.floor(whole / 1_000_000);
  const thou = Math.floor((whole % 1_000_000) / 1000);
  const rest = whole % 1000;
  if (mil) parts.push(trio(mil), plural(mil, ['миллион', 'миллиона', 'миллионов']));
  if (thou) parts.push(trio(thou, true), plural(thou, ['тысяча', 'тысячи', 'тысяч']));
  if (rest) parts.push(trio(rest));

  const s = parts.filter(Boolean).join(' ').trim();
  const head = s.charAt(0).toUpperCase() + s.slice(1);
  return `${head || 'Ноль'} тенге ${String(coins).padStart(2, '0')} тиын`;
}

import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { SyncGateway } from './sync.gateway';

/**
 * ПРОТОКОЛ СИНХРОНИЗАЦИИ.
 *
 * Конкуренты синхронизируют состояние («вот текущий список товаров»).
 * Мы синхронизируем события («в 14:03 продали 2 пачки»). Состояние двух касс
 * можно затереть, факты — нельзя сложить неправильно.
 *
 * Порядок задаёт сервер (seq), а не часы устройства: на кассе может стоять
 * 2019 год, и LWW по времени клиента развалил бы данные.
 */

export type Op = 'insert' | 'update' | 'delete';

export interface SyncEvent {
  id: string;                  // UUID с устройства → повтор отправки не создаёт дубль
  entity: string;
  entityId: string;
  op: Op;
  payload: Record<string, any>;
  clientSeq: number;           // сплошная нумерация на устройстве: дырка = отдано не всё
  clientTs: string;
  baseSeq?: number;            // версия строки, которую видел клиент → детект конфликта
  employeeId?: string;
  storeId?: string;
}

/**
 * Карта сущностей: что вообще можно менять через синхронизацию и какие поля.
 * Белый список, а не «пиши что хочешь»: касса не должна уметь поменять
 * себе разрешения или чужой аккаунт.
 * Части 2–4 дописывают сюда product, sale, stock_move и остальное.
 */
interface EntitySpec {
  table: string;
  fields: string[];            // поля, разрешённые к записи с устройства
  softDelete?: boolean;
  fromDevice?: boolean;        // можно ли принимать это событие от кассы
}

export const ENTITY_MAP: Record<string, EntitySpec> = {
  store:         { table: 'store',         fields: ['name', 'address', 'phone', 'is_active'], softDelete: true, fromDevice: false },
  cash_register: { table: 'cash_register', fields: ['name', 'section', 'app_version', 'last_sync_at'], softDelete: true, fromDevice: true },
  consultant:    { table: 'consultant',    fields: ['name', 'phone', 'store_id', 'is_active'], softDelete: true, fromDevice: true },
  unit:          { table: 'unit',          fields: ['name', 'short_name', 'name_kk', 'short_name_kk', 'kind', 'precision'], softDelete: true, fromDevice: false },
  // Часть 2: product, category, price… Часть 3: stock_move… Часть 4: sale, shift…
};

const MAX_BATCH = 500;         // длинный офлайн выгружается быстро, но канал не забивается

/**
 * Обработчик составной сущности.
 * Чек — это не строка в таблице: это шапка, позиции, оплаты и движения склада
 * разом. Такие сущности не ложатся в декларативную карту полей, поэтому модули
 * (касса, склад) регистрируют свои обработчики здесь.
 */
export type EntityHandler = (c: PoolClient, accountId: string, e: SyncEvent, ctx: { deviceId?: string }) => Promise<void>;

@Injectable()
export class SyncService {
  constructor(private db: DbService, private gateway: SyncGateway) {}

  /** Обработчики составных сущностей: 'sale' → касса, 'shift' → касса и т.д. */
  private handlers = new Map<string, EntityHandler>();

  registerHandler(entity: string, fn: EntityHandler) { this.handlers.set(entity, fn); }

  // ==================================================================
  // PUSH: приём батча событий с устройства
  // ==================================================================
  /**
   * ВЕРНУТЬ ЧЕКИ ИЗ КАРАНТИНА.
   *
   * Чек в карантине — это взятые деньги без учёта. Тело события лежит
   * целиком, и применить его можно тем же ходом, что и живые чеки.
   *
   * Порядок важен: сперва смены, потом чеки. Чек ссылается на смену, и
   * наоборот не выйдет.
   */
  async retryQuarantine(accountId: string, все = false) {
    /* ПОМЕЧЕННЫЕ, НО НЕ ПРИМЕНЁННЫЕ — ТОЖЕ ДЕНЬГИ.
     *
     * Прежний разбор помечал записи разобранными, а применить забывал.
     * Они остались с пометкой, и обычный разбор их больше не видит — а
     * чеков в продажах нет.
     *
     * С «все» берём и такие: проверяем по САМОЙ ТАБЛИЦЕ, лёг чек или
     * нет. Тело события цело, применить можно. */
    const записи = await this.db.withTenant(accountId, async (c) => (await c.query(
      `SELECT d.id, d.device_id, d.entity, d.entity_id, d.op, d.payload,
              d.client_ts, d.client_seq
         FROM oplog_dead_letter d
        WHERE d.account_id = $1
          AND (d.resolved_at IS NULL OR ($2::boolean AND NOT EXISTS (
                SELECT 1 FROM sale s WHERE s.id = d.entity_id
                UNION ALL
                SELECT 1 FROM shift sh WHERE sh.id = d.entity_id
                UNION ALL
                SELECT 1 FROM cash_operation co WHERE co.id = d.entity_id)))
        ORDER BY CASE d.entity WHEN 'shift' THEN 0 WHEN 'sale' THEN 1
                               WHEN 'refund' THEN 1 ELSE 2 END,
                 d.first_seen_at`, [accountId, все])).rows);

    if (!записи.length) return { всего: 0, применено: 0, осталось: 0, беды: [] };

    const события = записи.map((r) => ({
      id: r.id,
      entity: r.entity,
      entityId: r.entity_id,
      op: r.op,
      payload: r.payload,
      clientTs: r.client_ts,
      clientSeq: r.client_seq,
    }));

    /* Шлём ТЕМ ЖЕ ХОДОМ, что и живая касса: он и запишет, и применит.
       Устройство берём из первой записи — оно у магазина одно. */
    const итог = await this.push(accountId,
      { deviceId: записи[0].device_id || undefined }, события as any, 0);

    const принятые = (итог.results || [])
      .filter((r: any) => r.result === 'accepted' || r.result === 'duplicate')
      .map((r: any) => r.id);

    if (принятые.length) {
      await this.db.withTenant(accountId, async (c) => {
        await c.query(
          `UPDATE oplog_dead_letter SET resolved_at = now()
            WHERE account_id = $1 AND id = ANY($2::uuid[])`,
          [accountId, принятые]);
      });
    }

    const беды = (итог.results || [])
      .filter((r: any) => r.result !== 'accepted' && r.result !== 'duplicate')
      .map((r: any) => ({ id: r.id, error: String(r.error || '').slice(0, 120) }));

    return {
      всего: записи.length,
      применено: принятые.length,
      осталось: записи.length - принятые.length,
      беды: беды.slice(0, 5),
    };
  }

  async push(
    accountId: string,
    source: { deviceId?: string; employeeId?: string },
    events: SyncEvent[],
    pendingHint = 0,
  ) {
    if (events.length > MAX_BATCH) throw new BadRequestException(`Не больше ${MAX_BATCH} событий за раз`);

    const results: { id: string; result: string; serverSeq?: number; error?: string }[] = [];

    // Каждое событие — в своей транзакции: одно битое не должно
    // отменять весь батч (иначе касса застрянет навсегда на одном событии).
    for (const e of events) {
      try {
        const r = await this.db.withTenant(accountId, async (c) => this.applyOne(c, accountId, source, e));
        results.push(r);
      } catch (err: any) {
        // Событие нельзя терять молча — в карантин, владелец увидит
        await this.quarantine(accountId, source.deviceId, e, err.message ?? String(err));
        results.push({ id: e.id, result: 'quarantined', error: err.message ?? String(err) });
      }
    }

    if (source.deviceId) {
      await this.db.withTenant(accountId, async (c) => {
        await c.query(
          `INSERT INTO sync_cursor (device_id, account_id, pending_hint, last_push_at)
           VALUES ($1,$2,$3, now())
           ON CONFLICT (device_id) DO UPDATE SET pending_hint=$3, last_push_at=now(), updated_at=now()`,
          [source.deviceId, accountId, pendingHint]);
      });
    }

    // Толкаем остальным устройствам: «есть новое». Не 15 минут, а доли секунды.
    const applied = results.filter((r) => r.result === 'accepted');
    if (applied.length) {
      const maxSeq = Math.max(...applied.map((r) => r.serverSeq ?? 0));
      this.gateway.notifyAccount(accountId, { type: 'changes', seq: maxSeq, from: source.deviceId ?? 'admin' });
    }

    return { results, accepted: applied.length, serverSeq: await this.currentSeq(accountId) };
  }

  private async applyOne(c: PoolClient, accountId: string, source: { deviceId?: string; employeeId?: string }, e: SyncEvent) {
    const handler = this.handlers.get(e.entity);
    const spec = ENTITY_MAP[e.entity];
    if (!handler && !spec) throw new BadRequestException(`Неизвестная сущность: ${e.entity}`);
    if (!handler && source.deviceId && spec.fromDevice === false)
      throw new ForbiddenException(`Сущность ${e.entity} не принимается с кассы`);

    // 1) регистрируем событие в журнале (идемпотентно по UUID)
    const reg = await c.query(
      `SELECT * FROM sync_push_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [e.id, accountId, source.deviceId ?? null, e.employeeId ?? source.employeeId ?? null, e.storeId ?? null,
       e.entity, e.entityId, e.op, JSON.stringify(e.payload ?? {}), e.clientSeq ?? null,
       /* ВРЕМЯ СТАВИМ САМИ, ЕСЛИ КАССА НЕ ПРИСЛАЛА.
        * Найдено на боевом сервере: смены отбивались с «null value in
        * column client_ts» — и за смену цеплялись ВСЕ чеки магазина.
        * Метка нужна для порядка событий, а не для денег. Терять из-за
        * неё смену со всей выручкой несоразмерно. */
       e.clientTs ?? new Date().toISOString()]);

    if (reg.rows[0].result === 'duplicate')
      return { id: e.id, result: 'duplicate', serverSeq: Number(reg.rows[0].server_seq) };

    const serverSeq = Number(reg.rows[0].server_seq);

    // 2) применяем к данным: составные сущности — своим обработчиком
    if (handler) await handler(c, accountId, e, { deviceId: source.deviceId });
    else await this.applyToTable(c, accountId, spec, e, serverSeq);

    await c.query(`UPDATE oplog SET applied_at = now() WHERE id = $1`, [e.id]);
    return { id: e.id, result: 'accepted', serverSeq };
  }

  private async applyToTable(c: PoolClient, accountId: string, spec: EntitySpec, e: SyncEvent, serverSeq: number) {
    const data = e.payload ?? {};
    const cols = spec.fields.filter((f) => f in data);

    if (e.op === 'insert') {
      // ON CONFLICT DO NOTHING: то же событие через другой путь не должно падать
      const names = ['id', 'account_id', ...cols];
      const vals = [e.entityId, accountId, ...cols.map((f) => data[f])];
      await c.query(
        `INSERT INTO ${spec.table} (${names.join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')})
         ON CONFLICT (id) DO NOTHING`, vals);
      return;
    }

    if (e.op === 'delete') {
      if (spec.softDelete) await c.query(`UPDATE ${spec.table} SET deleted_at = now() WHERE id = $1`, [e.entityId]);
      else await c.query(`DELETE FROM ${spec.table} WHERE id = $1`, [e.entityId]);
      return;
    }

    // update: правило «последняя запись побеждает», но конфликт не прячем —
    // владелец должен видеть, что его правку цены перебила правка с кассы.
    const cur = await c.query(`SELECT seq FROM ${spec.table} WHERE id = $1`, [e.entityId]);
    if (!cur.rows[0]) throw new Error(`Строка ${e.entity}:${e.entityId} не найдена — нечего обновлять`);

    if (e.baseSeq != null && Number(cur.rows[0].seq) > e.baseSeq) {
      const prev = await c.query(
        `SELECT o.id, o.device_id FROM oplog o WHERE o.entity=$1 AND o.entity_id=$2 AND o.seq < $3
          ORDER BY o.seq DESC LIMIT 1`, [e.entity, e.entityId, serverSeq]);
      await c.query(
        `INSERT INTO sync_conflict (account_id, entity, entity_id, winner_oplog, loser_oplog,
                                    winner_source, loser_source, fields)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [accountId, e.entity, e.entityId, e.id, prev.rows[0]?.id ?? null,
         e.storeId ? `device:${e.storeId}` : 'admin', prev.rows[0]?.device_id ? 'device' : 'admin',
         JSON.stringify(cols)]);
    }

    if (!cols.length) return;
    const set = cols.map((f, i) => `${f} = $${i + 2}`).join(', ');
    await c.query(`UPDATE ${spec.table} SET ${set} WHERE id = $1`, [e.entityId, ...cols.map((f) => data[f])]);
  }

  private async quarantine(accountId: string, deviceId: string | undefined, e: SyncEvent, error: string) {
    await this.db.withTenant(accountId, async (c) => {
      await c.query(
        `INSERT INTO oplog_dead_letter (id, account_id, device_id, entity, entity_id, op, payload, error, client_ts, client_seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET attempts = oplog_dead_letter.attempts + 1,
                                        last_try_at = now(), error = EXCLUDED.error`,
        [e.id, accountId, deviceId ?? null, e.entity, e.entityId, e.op, JSON.stringify(e.payload ?? {}),
         error, e.clientTs, e.clientSeq ?? null]);
    });
  }

  // ==================================================================
  // PULL: отдача событий по курсору. Обрыв связи → докачка с места,
  // а не «начать сначала» (у Wipon полная синхронизация — с нуля).
  // ==================================================================
  async pull(accountId: string, since: number, limit = 200, deviceId?: string) {
    const lim = Math.min(limit, MAX_BATCH);
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, seq, entity, entity_id, op, payload, device_id, employee_id, client_ts, server_ts
           FROM oplog
          WHERE seq > $1 AND ($2::uuid IS NULL OR device_id IS DISTINCT FROM $2::uuid)
          ORDER BY seq LIMIT $3`,
        [since, deviceId ?? null, lim]);

      const head = (await c.query(`SELECT coalesce(max(seq),0)::bigint AS s FROM oplog`)).rows[0].s;

      if (deviceId && rows.length) {
        const last = Number(rows[rows.length - 1].seq);
        await c.query(
          `INSERT INTO sync_cursor (device_id, account_id, pulled_seq, last_pull_at)
           VALUES ($1,$2,$3, now())
           ON CONFLICT (device_id) DO UPDATE
             SET pulled_seq = greatest(sync_cursor.pulled_seq, $3), last_pull_at = now(), updated_at = now()`,
          [deviceId, accountId, last]);
      }

      return {
        events: rows.map((r: any) => ({
          id: r.id, seq: Number(r.seq), entity: r.entity, entityId: r.entity_id,
          op: r.op, payload: r.payload, deviceId: r.device_id,
          employeeId: r.employee_id, clientTs: r.client_ts, serverTs: r.server_ts,
        })),
        cursor: rows.length ? Number(rows[rows.length - 1].seq) : since,
        head: Number(head),
        hasMore: rows.length === lim,
      };
    });
  }

  private async currentSeq(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      Number((await c.query(`SELECT coalesce(max(seq),0)::bigint AS s FROM oplog`)).rows[0].s));
  }

  // ==================================================================
  // ГОТОВНОСТЬ К ИНВЕНТАРИЗАЦИИ.
  // UMAG пишет: «кассы должны быть синхронизированы, иначе остатки могут быть
  // неточными» — и оставляет владельца проверять глазами. Мы не гадаем:
  // нумерация событий устройства сплошная, дырка видна сразу.
  // ==================================================================
  async readiness(accountId: string, storeId?: string) {
    const { rows } = await this.db.raw(`SELECT * FROM sync_readiness($1,$2)`, [accountId, storeId ?? null]);
    const devices = rows.map((r: any) => ({
      deviceId: r.device_id,
      cashRegister: r.cash_register,
      lastPushAt: r.last_push_at,
      pending: r.pending_hint,
      hasGaps: r.has_gaps,
      onlineRecently: r.online_recently,
      ready: !r.has_gaps && r.pending_hint === 0,
    }));
    const notReady = devices.filter((d: any) => !d.ready);
    return {
      ready: notReady.length === 0,
      devices,
      message: notReady.length === 0
        ? 'Все кассы отдали данные — остатки актуальны, можно проводить инвентаризацию'
        : `Не все данные получены: ${notReady.map((d: any) => d.cashRegister ?? 'касса').join(', ')}. Дождитесь синхронизации.`,
    };
  }

  /** Карантин: что не удалось применить (владелец и поддержка это видят). */
  async deadLetters(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, entity, entity_id, op, error, attempts, first_seen_at, client_ts
           FROM oplog_dead_letter WHERE resolved_at IS NULL ORDER BY first_seen_at DESC LIMIT 100`);
      return rows;
    });
  }

  /** Журнал конфликтов: чья правка победила. */
  async conflicts(accountId: string) {
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, entity, entity_id, winner_source, loser_source, fields, created_at
           FROM sync_conflict ORDER BY created_at DESC LIMIT 100`);
      return rows;
    });
  }
}

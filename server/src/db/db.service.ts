import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

/**
 * Слой доступа к БД.
 *
 * Главное правило проекта: сервер ходит в базу под ролью shop_app
 * (НЕ суперпользователь), иначе RLS молча отключается и мультитенантность
 * превращается в фикцию. Каждая транзакция обязана выставить app.account_id —
 * это ключ, по которому RLS отдаёт строки только текущего клиента.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      host: process.env.PGHOST ?? 'localhost',
      port: +(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? 'shop_app',
      password: process.env.PGPASSWORD ?? 'change_me_in_prod',
      database: process.env.PGDATABASE ?? 'shop_dev',
      max: 20,
      idleTimeoutMillis: 30_000,
    });
  }

  /** Транзакция в контексте конкретного клиента (тенанта). */
  async withTenant<T>(accountId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // SET LOCAL живёт только внутри транзакции — соединение вернётся в пул чистым
      await c.query(`SET LOCAL app.account_id = '${accountId.replace(/'/g, '')}'`);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * Транзакция без тенанта — только для входа/регистрации, когда аккаунт ещё
   * неизвестен. RLS в этом режиме не отдаст ничего лишнего: таблицы с
   * account_id останутся пустыми, доступны только login_attempt (account_id IS NULL),
   * otp_code и функция register_account (SECURITY DEFINER).
   */
  async withoutTenant<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * Поиск сотрудника по телефону при входе: до входа аккаунт неизвестен,
   * а RLS закрывает employee. Используем SECURITY DEFINER-функцию, которая
   * отдаёт РОВНО минимум для проверки пароля — и ничего больше.
   */
  async findLoginByPhone(phone: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM auth_find_employee_by_phone($1)`, [phone],
    );
    return rows[0] ?? null;
  }

  async raw(sql: string, params: any[] = []) {
    return this.pool.query(sql, params);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

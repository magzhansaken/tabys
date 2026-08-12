import { Controller, Post, Get, Patch, Body, Param, Req, Headers, Module,
  BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Public } from '../auth/guards';

/**
 * ЗАЯВКИ С ЛЕНДИНГА (часть 19).
 *
 * Дифференциатор против UMAG: у них путь клиента начинается со «звонка
 * менеджера». У нас владелец регистрируется сам за 2 минуты, а форма заявки —
 * для тех, кто хочет, чтобы ему помогли с переездом (пилот).
 *
 * Защита публичной формы (интернет-форма без неё умирает от ботов за сутки):
 * 1) лимит 5 заявок в час с одного IP (в памяти: одного процесса достаточно,
 *    после рестарта счётчик обнуляется — для формы это не страшно);
 * 2) honeypot: скрытое поле `website` — человек его не видит и не заполняет,
 *    бот заполняет; таким отвечаем «ок» и молча выбрасываем.
 *
 * Чтение — только оператору по ключу из env OPERATOR_KEY: лиды — данные
 * владельца SaaS, в кабинете магазинов их нет.
 */
const ipHits = new Map<string, number[]>();
const LIMIT = 5;
const WINDOW_MS = 60 * 60 * 1000;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= LIMIT) { ipHits.set(ip, hits); return true; }
  hits.push(now);
  ipHits.set(ip, hits);
  return false;
}

export function requireOperator(key?: string) {
  const expected = process.env.OPERATOR_KEY;
  if (!expected) throw new ForbiddenException('Операторский доступ не настроен (OPERATOR_KEY)');
  if (key !== expected) throw new ForbiddenException('Неверный ключ оператора');
}

@Controller('public/leads')
export class LeadsController {
  constructor(private db: DbService) {}

  @Public() @Post()
  async create(@Body() d: {
    name: string; phone: string; city?: string; comment?: string;
    locale?: string; source?: string; website?: string;   // website — honeypot
  }, @Req() req: any) {
    // бот заполнил скрытое поле — отвечаем как обычно, но ничего не пишем
    if (d.website) return { ok: true };

    if (!d.name?.trim()) throw new BadRequestException('Как к вам обращаться?');
    const phone = (d.phone ?? '').replace(/[\s\-()]/g, '');
    if (!/^\+?7\d{10}$/.test(phone)) throw new BadRequestException('Телефон в формате +7 701 123 45 67');

    const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.ip ?? '').trim();
    if (rateLimited(ip)) throw new HttpException('Слишком много заявок — попробуйте позже', 429);

    const { rows } = await this.db.raw(
      `INSERT INTO lead (name, phone, city, comment, source, locale, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [d.name.trim(), phone, d.city ?? null, d.comment?.slice(0, 500) ?? null,
       d.source ?? 'landing', d.locale ?? 'ru', ip || null]);
    return { ok: true, id: rows[0].id };
  }

  /** Список заявок — только оператору по ключу */
  @Public() @Get()
  async list(@Headers('x-operator-key') key?: string) {
    requireOperator(key);
    const { rows } = await this.db.raw(
      `SELECT id, name, phone, city, comment, source, locale, status, created_at
         FROM lead ORDER BY created_at DESC LIMIT 500`);
    return { items: rows, total: rows.length };
  }

  @Public() @Patch(':id')
  async setStatus(@Param('id') id: string, @Body() d: { status: string },
                  @Headers('x-operator-key') key?: string) {
    requireOperator(key);
    if (!['new', 'called', 'converted', 'spam'].includes(d.status))
      throw new BadRequestException('status: new | called | converted | spam');
    await this.db.raw(`UPDATE lead SET status=$2 WHERE id=$1`, [id, d.status]);
    return { ok: true };
  }
}

@Module({ controllers: [LeadsController], providers: [DbService] })
export class LeadsModule {}

import { Controller, Get, Module, Injectable, Res, NotFoundException } from '@nestjs/common';
import { Public } from '../auth/guards';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * ОБНОВЛЕНИЕ КАССЫ ПО СЕТИ (этап 10).
 *
 * Магазина приложений нет, поэтому свой канал: файл с описанием версии
 * и сам установщик лежат на сервере, касса их спрашивает.
 *
 * ГЛАВНОЕ ПРАВИЛО, взятое у соседнего проекта дословно: НИКОГДА не
 * обновлять кассу автоматически посреди смены. Спрашивать, показывать
 * «что нового», ставить по согласию кассира — лучше при закрытой смене.
 * Обновление, начавшееся во время очереди, — это остановка торговли.
 *
 * Файлы кладутся в /opt/tabys/deploy/updates:
 *   latest.json  — версия, что нового, имя файла
 *   Tabys-Kassa-<версия>-setup.exe
 *
 * Раздаём своим сервером, а не отдельным маршрутом: путь /api/* уже
 * работает, и трогать настройки ресторана ради этого не нужно.
 */

const UPDATES_DIR = process.env.UPDATES_DIR ?? '/updates';

@Injectable()
export class PosUpdateService {
  /** Описание последней версии. Хэш считаем один раз и запоминаем: файл
   *  весит сотни мегабайт, пересчитывать на каждый запрос нельзя. */
  private cache: { mtime: number; data: any } | null = null;

  latest() {
    const metaPath = path.join(UPDATES_DIR, 'latest.json');
    if (!fs.existsSync(metaPath)) return { available: false };

    const stat = fs.statSync(metaPath);
    if (this.cache && this.cache.mtime === stat.mtimeMs) return this.cache.data;

    let meta: any;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
    catch { return { available: false, error: 'Файл описания версии испорчен' }; }

    const filePath = path.join(UPDATES_DIR, meta.file ?? '');
    if (!meta.file || !fs.existsSync(filePath))
      return { available: false, error: 'Установщик не найден на сервере' };

    const fstat = fs.statSync(filePath);
    // Хэш нужен кассе, чтобы убедиться: скачалось целиком и не побилось.
    // Ставить битый установщик хуже, чем не обновляться вовсе.
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

    const data = {
      available: true,
      version: meta.version,
      notes: meta.notes ?? '',
      size: fstat.size,
      sha256: hash,
      url: '/pos/update/download',
      published: fstat.mtime.toISOString(),
    };
    this.cache = { mtime: stat.mtimeMs, data };
    return data;
  }

  fileStream() {
    const meta = this.latest() as any;
    if (!meta.available) throw new NotFoundException('Обновление не готово');
    return {
      path: path.join(UPDATES_DIR, JSON.parse(fs.readFileSync(path.join(UPDATES_DIR, 'latest.json'), 'utf8')).file),
      name: `Tabys-Kassa-${meta.version}-setup.exe`,
      size: meta.size,
    };
  }
}

@Controller('pos/update')
export class PosUpdateController {
  constructor(private svc: PosUpdateService) {}

  /** Касса спрашивает: есть ли версия новее моей. Без токена: проверка
   *  версии не раскрывает ничего, а требовать вход мешало бы обновиться
   *  кассе, у которой протух токен. */
  @Public() @Get('latest')
  latest() { return this.svc.latest(); }

  @Public() @Get('download')
  download(@Res() res: any) {
    const f = this.svc.fileStream();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(f.size));
    res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
    fs.createReadStream(f.path).pipe(res);
  }
}

@Module({ controllers: [PosUpdateController], providers: [PosUpdateService] })
export class PosUpdateModule {}

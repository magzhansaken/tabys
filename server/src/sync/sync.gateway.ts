import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { AuthService } from '../auth/auth.service';

/**
 * Уведомления «есть новое».
 *
 * Wipon опрашивает сервер раз в 15 минут: касса №1 продала последнюю пачку —
 * касса №2 узнает через четверть часа. UMAG требует ручной синхронизации,
 * чтобы правка вступила в силу. Мы толкаем уведомление сразу.
 *
 * Важно: по сокету идёт только сигнал «забери с seq N», сами данные всегда
 * тянутся по HTTP. Так меньше кода, проще отладка, и потеря сокета не рвёт
 * согласованность — периодический опрос остаётся страховкой.
 */
@Injectable()
export class SyncGateway implements OnModuleDestroy {
  private wss?: WebSocketServer;
  /** accountId → живые соединения */
  private clients = new Map<string, Set<WebSocket & { accountId?: string; deviceId?: string }>>();

  constructor(private auth: AuthService) {}

  attach(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/sync/live' });

    this.wss.on('connection', async (ws: any, req) => {
      try {
        const url = new URL(req.url ?? '', 'http://x');
        const deviceToken = url.searchParams.get('deviceToken');
        if (!deviceToken) return ws.close(4001, 'Нужен токен устройства');

        const dev = await this.auth.resolveDevice(deviceToken);
        ws.accountId = dev.account_id;
        ws.deviceId = dev.device_id;

        if (!this.clients.has(dev.account_id)) this.clients.set(dev.account_id, new Set());
        this.clients.get(dev.account_id)!.add(ws);

        ws.send(JSON.stringify({ type: 'ready', deviceId: dev.device_id }));

        // Пульс: обрыв связи в магазине — норма, надо замечать его быстро,
        // а не ждать таймаута TCP в несколько минут.
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('close', () => this.clients.get(ws.accountId)?.delete(ws));
        ws.on('error', () => this.clients.get(ws.accountId)?.delete(ws));
      } catch {
        ws.close(4003, 'Устройство не опознано');
      }
    });

    const beat = setInterval(() => {
      this.wss?.clients.forEach((ws: any) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      });
    }, 30_000);
    this.wss.on('close', () => clearInterval(beat));
  }

  /** Толкнуть всем устройствам аккаунта: «есть новое, забери с seq N». */
  notifyAccount(accountId: string, msg: { type: string; seq: number; from?: string }) {
    const set = this.clients.get(accountId);
    if (!set) return 0;
    let sent = 0;
    for (const ws of set) {
      // тому, кто это событие и породил, уведомление не нужно
      if (ws.deviceId && msg.from === ws.deviceId) continue;
      if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify(msg)); sent++; }
    }
    return sent;
  }

  connectionsOf(accountId: string) { return this.clients.get(accountId)?.size ?? 0; }

  onModuleDestroy() { this.wss?.close(); }
}

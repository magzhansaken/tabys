import 'dart:async';
import 'dart:convert';
import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../data/local_db.dart';
import 'api_client.dart';

/// ДВИЖОК СИНХРОНИЗАЦИИ КАССЫ.
///
/// Три правила (часть 1.3):
/// 1. Всё, что случилось на кассе, сначала пишется в Outbox той же
///    транзакцией, что и сами данные. Отправка — потом, повтор — не дубль.
/// 2. clientSeq — сплошная нумерация: сервер видит дырку, если что-то
///    не доехало (иначе инвентаризация считает неправду — предупреждение UMAG).
/// 3. Очередь очищается только после подтверждения сервера, никогда — до.
///
/// Wipon различает «фоновую», «полную» и «ручную» синхронизацию и заставляет
/// пользователя об этом думать. У нас режим один: снимок при привязке,
/// дальше дельты; WebSocket толкает «есть новое» за доли секунды, а если
/// сокет упал — таймер раз в 30 секунд.
class SyncEngine {
  SyncEngine(this.db, this.api);

  final LocalDb db;
  final ApiClient api;

  static const pushBatch = 100;                 // как эталон из part4.criteria
  static const pullBatch = 200;
  static const retryEvery = Duration(seconds: 30);

  Timer? _timer;
  WebSocketChannel? _ws;
  bool _busy = false;

  final _pendingCtrl = StreamController<int>.broadcast();
  Stream<int> get pendingStream => _pendingCtrl.stream;

  // ==================================================================
  // ЗАПИСЬ СОБЫТИЯ: вызывается из транзакций продажи/смены
  // ==================================================================
  Future<void> enqueue({
    required String entity,
    required String entityId,
    required String op,
    required Map<String, dynamic> payload,
    String? employeeId,
  }) async {
    await db.transaction(() async {
      final st = await (db.select(db.syncState)..limit(1)).getSingleOrNull();
      final seq = st?.nextClientSeq ?? 1;
      await db.into(db.outbox).insert(OutboxCompanion.insert(
            id: const Uuid().v4(),
            clientSeq: seq,
            entity: entity,
            entityId: entityId,
            op: op,
            payload: jsonEncode({...payload, if (employeeId != null) '_employeeId': employeeId}),
            clientTs: DateTime.now(),
          ));
      await db.into(db.syncState).insertOnConflictUpdate(
            SyncStateCompanion(id: const Value(1), nextClientSeq: Value(seq + 1),
              pulledSeq: Value(st?.pulledSeq ?? 0)),
          );
    });
    _pendingCtrl.add(await db.pendingCount());
    unawaited(pushNow());                       // попытка сразу; офлайн — молча в очередь
  }

  // ==================================================================
  // PUSH: очередь → сервер, батчами, до подтверждения ничего не чистим
  // ==================================================================
  Future<int> pushNow() async {
    if (_busy) return 0;
    _busy = true;
    var accepted = 0;
    try {
      while (true) {
        final rows = await (db.select(db.outbox)
              ..where((t) => t.sentAt.isNull())
              ..orderBy([(t) => OrderingTerm.asc(t.clientSeq)])
              ..limit(pushBatch))
            .get();
        if (rows.isEmpty) break;

        final events = rows.map((e) {
          final p = jsonDecode(e.payload) as Map<String, dynamic>;
          final employeeId = p.remove('_employeeId');
          return {
            'id': e.id, 'entity': e.entity, 'entityId': e.entityId, 'op': e.op,
            'payload': p, 'clientSeq': e.clientSeq,
            'clientTs': e.clientTs.toUtc().toIso8601String(),
            if (employeeId != null) 'employeeId': employeeId,
          };
        }).toList();

        final pending = await db.pendingCount();
        final res = await api.post('/sync/push', {'events': events, 'pending': pending});
        final results = (res['results'] as List).cast<Map<String, dynamic>>();

        final now = DateTime.now();
        for (final r in results) {
          // accepted и duplicate — обе означают «сервер это уже знает»
          if (r['result'] == 'accepted' || r['result'] == 'duplicate') {
            await (db.update(db.outbox)..where((t) => t.id.equals(r['id'] as String)))
                .write(OutboxCompanion(sentAt: Value(now)));
            accepted++;
          } else {
            // карантин: сервер сохранил у себя, у нас событие помечено ошибкой,
            // но очередь не встаёт — владелец разберёт в кабинете
            await (db.update(db.outbox)..where((t) => t.id.equals(r['id'] as String))).write(
              OutboxCompanion(
                sentAt: Value(now),
                lastError: Value(r['error']?.toString() ?? r['result'].toString()),
              ),
            );
          }
        }
        if (results.length < pushBatch) break;
      }
    } on OfflineException {
      // норма жизни: интернет вернётся — таймер или сокет дожмут
    } finally {
      _busy = false;
      _pendingCtrl.add(await db.pendingCount());
    }
    return accepted;
  }

  // ==================================================================
  // PULL: дельты каталога с сервера в локальную базу
  // ==================================================================
  Future<void> pullNow() async {
    try {
      while (true) {
        final st = await (db.select(db.syncState)..limit(1)).getSingleOrNull();
        final since = st?.pulledSeq ?? 0;
        final res = await api.get('/sync/pull', query: {'since': '$since', 'limit': '$pullBatch'});
        final events = (res['events'] as List).cast<Map<String, dynamic>>();

        for (final e in events) {
          await _applyServerEvent(e);
        }
        await db.into(db.syncState).insertOnConflictUpdate(SyncStateCompanion(
              id: const Value(1),
              pulledSeq: Value(res['cursor'] as int),
              nextClientSeq: Value(st?.nextClientSeq ?? 1),
              lastPullAt: Value(DateTime.now()),
            ));
        if (res['hasMore'] != true) break;
      }
    } on OfflineException {
      // дельты подождут
    }
  }

  /// Изменение с сервера → локальный каталог. Товары и цены правит кабинет,
  /// касса применяет; свои события (чеки) сервер нам не возвращает.
  Future<void> _applyServerEvent(Map<String, dynamic> e) async {
    final p = (e['payload'] as Map?)?.cast<String, dynamic>() ?? {};
    switch (e['entity']) {
      case 'product':
        if (e['op'] == 'delete') {
          await (db.update(db.products)..where((t) => t.id.equals(e['entityId'] as String)))
              .write(const ProductsCompanion(archived: Value(true)));
        } else {
          await db.into(db.products).insertOnConflictUpdate(ProductsCompanion(
                id: Value(e['entityId'] as String),
                name: Value(p['name'] as String? ?? ''),
                kind: Value(p['kind'] as String? ?? 'simple'),
                price: Value((p['price'] as num?)?.toDouble() ?? 0),
                cost: Value((p['cost'] as num?)?.toDouble() ?? 0),
                minPrice: Value((p['minPrice'] as num?)?.toDouble()),
                vatRate: Value((p['vatRate'] as num?)?.toDouble()),
                ntin: Value(p['ntin'] as String?),
                trackStock: Value(p['trackStock'] as bool? ?? true),
              ));
        }
      case 'price':
        await (db.update(db.products)..where((t) => t.id.equals(p['productId'] as String)))
            .write(ProductsCompanion(price: Value((p['value'] as num).toDouble())));
      case 'category':
        await db.into(db.categories).insertOnConflictUpdate(CategoriesCompanion(
              id: Value(e['entityId'] as String),
              name: Value(p['name'] as String? ?? ''),
              parentId: Value(p['parentId'] as String?),
            ));
      default:
        // незнакомая сущность — молча пропускаем: старое приложение не должно
        // падать от новых типов событий (сервер сообщает minPosVersion отдельно)
        break;
    }
  }

  // ==================================================================
  // ЖИВОЙ КАНАЛ: сокет толкает «есть новое», таймер — страховка
  // ==================================================================
  void start({required String wsUrl, required String deviceToken}) {
    _timer?.cancel();
    _timer = Timer.periodic(retryEvery, (_) {
      pushNow();
      pullNow();
    });
    _connectWs(wsUrl, deviceToken);
  }

  void _connectWs(String wsUrl, String token) {
    try {
      _ws = WebSocketChannel.connect(Uri.parse('$wsUrl?deviceToken=$token'));
      _ws!.stream.listen(
        (msg) {
          final m = jsonDecode(msg as String);
          if (m['type'] == 'changes') pullNow();
        },
        onDone: () => Future.delayed(const Duration(seconds: 5), () => _connectWs(wsUrl, token)),
        onError: (_) {},
      );
    } catch (_) {
      // без сокета жизнь продолжается: таймер каждые 30 секунд
    }
  }

  void stop() {
    _timer?.cancel();
    _ws?.sink.close();
  }
}

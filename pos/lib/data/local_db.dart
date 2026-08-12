import 'dart:io';
import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path/path.dart' as p;
import 'local_schema.dart';

part 'local_db.g.dart';

/// Локальная база кассы — источник правды для кассира.
/// Файл лежит в данных приложения; при попытке удалить приложение с
/// непустой очередью Outbox интерфейс предупреждает числом неотправленных
/// (у Wipon такие продажи просто теряются — прямо написано в их доке).
@DriftDatabase(tables: [
  Staff, PosSettings, LocalSessions, Outbox, SyncState, LoginAttempts, Approvals,
  Products, Barcodes, Categories, Shifts, Sales, SaleItems, CashOps, CancelledItems, Customers,
])
class LocalDb extends _$LocalDb {
  LocalDb() : super(_open());
  LocalDb.forTesting(super.e);

  @override
  int get schemaVersion => 3;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) async => m.createAll(),
        onUpgrade: (m, from, to) async {
          if (from < 2) {
            // Часть 16: торговые таблицы поверх каркаса части 1
            for (final t in [products, barcodes, categories, shifts, sales, saleItems, cashOps, cancelledItems]) {
              await m.createTable(t);
            }
          }
          if (from < 3) {
            // Часть 17: покупатели на кассе (долг, лимит, бонусы)
            await m.createTable(customers);
          }
        },
      );

  /// Число неотправленных событий — для плашки «не отдано N» на экране
  /// и предупреждения при выходе.
  Future<int> pendingCount() async {
    final row = await customSelect('SELECT count(*) AS n FROM outbox WHERE sent_at IS NULL').getSingle();
    return row.read<int>('n');
  }
}

QueryExecutor _open() {
  return LazyDatabase(() async {
    final dir = await getApplicationSupportDirectory();
    final file = File(p.join(dir.path, 'shop_pos.sqlite'));
    return NativeDatabase.createInBackground(file);
  });
}

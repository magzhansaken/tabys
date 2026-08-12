import 'dart:convert';
import 'package:bcrypt/bcrypt.dart';
import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';
import '../data/local_schema.dart';
import '../data/local_db.dart';

/// ОФЛАЙН-АУТЕНТИФИКАЦИЯ.
///
/// Ради этого затевалась вся 1.2. У Wipon вход в Desktop — по телефону и
/// паролю от кабинета (то есть требует сервера и светит учётку владельца
/// в торговом зале). У UMAG офлайн в документации не упомянут ни разу.
///
/// Здесь вход не спрашивает сервер вообще: хэши PIN, роли и разрешения
/// приехали при привязке и лежат в локальной базе. Упал интернет ночью —
/// кассир всё равно откроет смену.
class OfflineAuth {
  final LocalDb db;
  OfflineAuth(this.db);

  static const int lockAfterFails = 5;
  static const Duration lockWindow = Duration(minutes: 5);

  /// Блокировка перебора работает и без сети — считаем по локальному журналу.
  Future<bool> isLockedOut() async {
    final since = DateTime.now().subtract(lockWindow);
    final fails = await (db.select(db.loginAttempts)
          ..where((t) => t.success.equals(false) & t.ts.isBiggerThanValue(since)))
        .get();
    return fails.length >= lockAfterFails;
  }

  /// Вход кассира по PIN. Никаких сетевых запросов.
  /// Возвращает сотрудника или null, если PIN не подошёл.
  Future<StaffData?> loginByPin(String pin) async {
    if (await isLockedOut()) {
      throw const PosAuthException('Слишком много неверных PIN. Подождите 5 минут.');
    }

    final staff = await db.select(db.staff).get();
    for (final s in staff) {
      if (BCrypt.checkpw(pin, s.pinHash)) {
        await db.into(db.loginAttempts).insert(
              LoginAttemptsCompanion.insert(success: true, ts: DateTime.now()),
            );
        await _openSession(s.id);
        return s;
      }
    }

    await db.into(db.loginAttempts).insert(
          LoginAttemptsCompanion.insert(success: false, ts: DateTime.now()),
        );
    return null;
  }

  /// Переключение кассира внутри смены (модель Wipon «администратор смены»,
  /// но по PIN за две секунды, и каждая операция подписана исполнителем).
  Future<void> _openSession(String staffId) async {
    await (db.update(db.localSessions)..where((t) => t.endedAt.isNull())).write(
      LocalSessionsCompanion(endedAt: Value(DateTime.now()), endReason: const Value('switch_user')),
    );
    await db.into(db.localSessions).insert(LocalSessionsCompanion.insert(
          id: const Uuid().v4(),
          staffId: staffId,
          startedAt: DateTime.now(),
          offline: const Value(true),
        ));
  }

  /// Подтверждение действия старшим (UMAG: скан штрихкода администратора).
  /// Наше расширение: бейдж ИЛИ PIN, офлайн, две подписи в журнале.
  Future<StaffData?> approve({
    required String requestedBy,
    required String action,
    String? badge,
    String? pin,
  }) async {
    final staff = await db.select(db.staff).get();
    StaffData? approver;

    if (badge != null) {
      for (final s in staff) {
        final admin = s.isOwner || s.isShiftAdmin || s.roleCode == 'admin' || s.roleCode == 'owner';
        if (admin && s.badgeBarcode == badge) { approver = s; break; }
      }
    } else if (pin != null) {
      for (final s in staff) {
        final admin = s.isOwner || s.isShiftAdmin || s.roleCode == 'admin' || s.roleCode == 'owner';
        if (admin && BCrypt.checkpw(pin, s.pinHash)) { approver = s; break; }
      }
    }
    if (approver == null) return null;

    await db.into(db.approvals).insert(ApprovalsCompanion.insert(
          id: const Uuid().v4(),
          requestedBy: requestedBy,
          approvedBy: approver.id,
          action: action,
          method: badge != null ? 'badge' : 'pin',
          approvedAt: DateTime.now(),
        ));
    return approver;
  }

  /// Права проверяются локально по той же матрице, что на сервере.
  /// Правило: сервер — истина, касса — быстрый ответ.
  bool can(StaffData s, String section, String action) {
    final perms = jsonDecode(s.permissions) as Map<String, dynamic>;
    if (perms['*'] is Map && (perms['*'] as Map)[action] == true) return true;
    final sec = perms[section];
    return sec is Map && sec[action] == true;
  }

  /// Разрешения кассы (профиль точки) — тоже локально.
  Future<Map<String, dynamic>> posProfile() async {
    final row = await (db.select(db.posSettings)..limit(1)).getSingleOrNull();
    return row == null ? {} : jsonDecode(row.json) as Map<String, dynamic>;
  }
}

class PosAuthException implements Exception {
  final String message;
  const PosAuthException(this.message);
  @override
  String toString() => message;
}

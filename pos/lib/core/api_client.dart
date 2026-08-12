import 'dart:async';
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// Сетевой клиент кассы.
///
/// Токен устройства — в хранилище ОС (Keychain/Keystore/Credential Manager),
/// а не в файле рядом с программой: у Wipon Desktop вход в кассу — логин и
/// пароль владельца, то есть учётка светится в торговом зале. У нас в зале
/// только PIN, а фактор владения — само устройство.
///
/// Правило сети: короткий таймаут и никакой блокировки продажи. Если сервер
/// не ответил за 4 секунды — работаем офлайн, очередь догонит.
class ApiClient {
  ApiClient({required this.baseUrl});

  final String baseUrl;
  static const _storage = FlutterSecureStorage();
  static const _tokenKey = 'device_token';
  static const timeout = Duration(seconds: 4);

  String? _token;

  Future<String?> deviceToken() async => _token ??= await _storage.read(key: _tokenKey);

  Future<void> saveToken(String token) async {
    _token = token;
    await _storage.write(key: _tokenKey, value: token);
  }

  Future<void> forget() async {
    _token = null;
    await _storage.delete(key: _tokenKey);
  }

  Uri _u(String path, [Map<String, String>? q]) =>
      Uri.parse('$baseUrl$path').replace(queryParameters: q);

  Future<Map<String, String>> _headers() async => {
        'Content-Type': 'application/json',
        if (_token ?? await deviceToken() case final t?) 'X-Device-Token': t,
      };

  /// GET. Бросает [OfflineException], если сети нет — вызывающий решает,
  /// критично это (привязка) или нет (фоновая синхронизация).
  Future<dynamic> get(String path, {Map<String, String>? query}) async {
    try {
      final r = await http.get(_u(path, query), headers: await _headers()).timeout(timeout);
      return _decode(r);
    } on TimeoutException {
      throw const OfflineException();
    } on http.ClientException {
      throw const OfflineException();
    }
  }

  Future<dynamic> post(String path, Object body) async {
    try {
      final r = await http
          .post(_u(path), headers: await _headers(), body: jsonEncode(body))
          .timeout(timeout);
      return _decode(r);
    } on TimeoutException {
      throw const OfflineException();
    } on http.ClientException {
      throw const OfflineException();
    }
  }

  dynamic _decode(http.Response r) {
    final data = r.body.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    if (r.statusCode >= 400) {
      throw ApiException(
        (data is Map && data['message'] != null) ? data['message'].toString() : 'Ошибка ${r.statusCode}',
        r.statusCode,
      );
    }
    return data;
  }
}

class OfflineException implements Exception {
  const OfflineException();
  @override
  String toString() => 'Нет связи с сервером';
}

class ApiException implements Exception {
  final String message;
  final int status;
  const ApiException(this.message, this.status);
  @override
  String toString() => message;
}

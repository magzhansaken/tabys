'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Btn, Input, dt, C, ErrLine, Badge } from '../../../lib/ui';

/**
 * Точки и кассы (часть 17): создать кассу, выписать код привязки, следить
 * за синхронизацией. Модель UMAG «Управление кассами»: одноразовый ключ
 * авторизации, платформа и время последней синхронизации в таблице.
 * У нас код живёт 10 минут — светить его дольше незачем.
 */
export default function StoresPage() {
  const [stores, setStores] = useState<any[]>([]);
  const [ready, setReady] = useState<any>(null);
  const [code, setCode] = useState<any>(null);        // {registerName, code}
  const [name, setName] = useState('');
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      setStores(await api('/admin/stores'));
      setReady(await api('/admin/sync/readiness'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const createRegister = async () => {
    setErr('');
    try {
      await api('/admin/stores/registers', { method: 'POST',
        body: JSON.stringify({ name: name || undefined }) });
      setName(''); load();
    } catch (e: any) { setErr(e.message); }
  };

  const pairingCode = async (reg: any) => {
    setErr('');
    try {
      const r = await api('/auth/devices/pairing-code', { method: 'POST',
        body: JSON.stringify({ cashRegisterId: reg.id }) });
      setCode({ registerName: reg.name, code: r.code });
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Точки и кассы</h1>
      <ErrLine err={err} />

      {code && (
        <Card title={`Код привязки — ${code.registerName}`} style={{ marginTop: 14 }}
              right={<Btn kind="ghost" onClick={() => setCode(null)}>Закрыть</Btn>}>
          <div style={{ fontSize: 40, letterSpacing: 8, fontWeight: 700, textAlign: 'center', padding: '8px 0' }}>
            {code.code}
          </div>
          <p style={{ fontSize: 13, color: C.dim, textAlign: 'center', margin: 0 }}>
            Введите на кассе. Код одноразовый и действует 10 минут.
          </p>
        </Card>
      )}

      {stores.map((s: any) => (
        <Card key={s.id} title={s.name || 'Точка'} style={{ marginTop: 14 }}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Input placeholder="Название кассы" value={name} w={160}
                     onChange={(e: any) => setName(e.target.value)} />
              <Btn onClick={createRegister}>Создать кассу</Btn>
            </div>
          }>
          <DataTable storageKey="stores" exportName="stores" empty="Касс пока нет — создайте первую и привяжите устройство"
            cols={[
              { h: 'Касса', k: 'name' },
              { h: 'Устройств', right: true, k: 'devices' },
              { h: 'Последняя связь', r: (r) => dt(r.last_seen_at) },
              { h: 'Статус', r: (r) => r.is_active !== false
                  ? <Badge tone="ok">активна</Badge> : <Badge tone="dim">выключена</Badge> },
              { h: '', r: (r) => <Btn kind="ghost" onClick={() => pairingCode(r)}>Код привязки</Btn> },
            ]}
            rows={s.registers ?? []} />
        </Card>
      ))}

      <Card title="Синхронизация касс" style={{ marginTop: 14 }}>
        {ready ? (
          ready.ready
            ? <Badge tone="ok">Все кассы отдали данные — отчётам и инвентаризации можно верить</Badge>
            : <div>
                <Badge tone="warn">Есть непереданные данные</Badge>
                <p style={{ fontSize: 13, color: C.dim, marginBottom: 0 }}>
                  Перед инвентаризацией дождитесь синхронизации: иначе остатки будут врать
                  (об этом же предупреждает и UMAG).
                </p>
              </div>
        ) : 'Загрузка…'}
      </Card>
    </>
  );
}

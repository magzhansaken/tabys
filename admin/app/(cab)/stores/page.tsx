'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, RevealOnce, Btn, Input, dt, MONO, C, ErrLine, Badge } from '../../../lib/ui';

/**
 * Точки и кассы (часть 17): создать кассу, выписать код привязки, следить
 * за синхронизацией. Модель UMAG «Управление кассами»: одноразовый ключ
 * авторизации, платформа и время последней синхронизации в таблице.
 * У нас код живёт 10 минут — светить его дольше незачем.
 *
 * Код привязки показывается через RevealOnce: его переписывают на планшет
 * руками, глядя в экран, и он умирает через 10 минут. Поэтому крупно, с
 * разрядкой и обратным отсчётом — чтобы человек не диктовал мёртвый код.
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

  const registers = stores.reduce((s: number, x: any) => s + (x.registers?.length ?? 0), 0);
  const devices = stores.reduce((s: number, x: any) =>
    s + (x.registers ?? []).reduce((d: number, r: any) => d + Number(r.devices ?? 0), 0), 0);

  return (
    <>
      <PageHeader
        title="Точки и кассы"
        fact={`${stores.length} точек · ${registers} касс · ${devices} устройств`}
      />
      <ErrLine err={err} />

      {code && (
        <div style={{ marginTop: 14 }}>
          <RevealOnce
            title={`Код привязки — ${code.registerName}`}
            value={code.code}
            ttl={600}
            onExpire={() => {}}
            note="Введите этот код на кассе в окне привязки устройства. Код одноразовый: после привязки он больше не действует, а через 10 минут сгорает сам — тогда просто выпишите новый."
          />
          <div style={{ marginTop: 10 }}>
            <Btn kind="ghost" onClick={() => setCode(null)}>Закрыть</Btn>
          </div>
        </div>
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
          <DataTable storageKey="stores" exportName="stores" search={false}
            hint="Касса — это рабочее место, устройство — планшет или компьютер за прилавком. Чтобы устройство заработало, выпишите код привязки и введите его на кассе."
            empty="Касс пока нет — создайте первую и привяжите устройство"
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
            : <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start',
                background: '#FFFBFA', border: `1px solid #E6C7C0`, borderRadius: 10, padding: '13px 15px' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.red, flex: '0 0 7px', marginTop: 7 }} />
                <div>
                  <div style={{ fontSize: 14.5, fontWeight: 600, color: C.red }}>Есть непереданные данные</div>
                  <p style={{ fontSize: 13.5, color: C.prose, margin: '6px 0 0', lineHeight: 1.55, maxWidth: '76ch' }}>
                    Не начинайте инвентаризацию сейчас: часть продаж ещё не доехала до сервера,
                    расхождение получится вымышленным — и вы спишете товар, который на самом деле продан.
                    Дождитесь, пока кассы отдадут данные.
                  </p>
                </div>
              </div>
        ) : 'Загрузка…'}
      </Card>
    </>
  );
}

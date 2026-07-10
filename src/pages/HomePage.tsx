import React, { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

export function HomePage() {
  const { events, settings, isLoading, error, loadEvents, loadSettings, appendPeeEvent } = useAppStore()
  const [dataInfo, setDataInfo] = useState<any>(null)

  useEffect(() => {
    loadEvents()
    loadSettings()
    if (typeof window !== 'undefined' && window.babyDiary) {
      window.babyDiary.getDataInfo().then(setDataInfo).catch(console.error)
    }
  }, [])

  const activeEvents = events.filter(e => !e.deleted)

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>Baby Diary - P1 테스트</h1>

      {isLoading && <p>로딩 중...</p>}
      {error && <p style={{ color: 'red' }}>오류: {error}</p>}

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>이벤트 수: {activeEvents.length}</h2>
        <button
          onClick={appendPeeEvent}
          style={{ padding: '0.5rem 1rem', fontSize: '1rem', cursor: 'pointer' }}
        >
          소변 기록 추가 (테스트)
        </button>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>설정</h2>
        {settings ? (
          <pre style={{ background: '#f5f5f5', padding: '1rem', borderRadius: '4px' }}>
            {JSON.stringify(settings, null, 2)}
          </pre>
        ) : (
          <p>설정 없음</p>
        )}
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>데이터 정보</h2>
        {dataInfo ? (
          <pre style={{ background: '#f5f5f5', padding: '1rem', borderRadius: '4px' }}>
            {JSON.stringify(dataInfo, null, 2)}
          </pre>
        ) : (
          <p>정보 없음</p>
        )}
      </section>

      <section>
        <h2>최근 이벤트 (최대 5개)</h2>
        <ul>
          {activeEvents.slice(-5).reverse().map(e => (
            <li key={`${e.id}-${e.rev}`}>
              [{e.type}] {e.at} - rev {e.rev}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

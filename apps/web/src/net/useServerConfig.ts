// 서버 기능 게이팅 훅: VITE_API_URL 미설정 / 연결 실패 / 기능 꺼짐 / 사용 가능
import { useCallback, useEffect, useState } from 'react';
import type { RuntimeConfig } from '@mba/shared';
import { api } from './api.ts';

export type ServerStatus = 'unconfigured' | 'checking' | 'offline' | 'ready';

export interface ServerConfigState {
  status: ServerStatus;
  config: RuntimeConfig | null;
  error: string | null;
  retry: () => void;
}

export function useServerConfig(): ServerConfigState {
  const [state, setState] = useState<Omit<ServerConfigState, 'retry'>>(() => ({ status: api ? 'checking' : 'unconfigured', config: null, error: null }));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.getConfig(nonce > 0).then(({ config, error }) => {
      if (!alive) return;
      setState(config ? { status: 'ready', config, error: null } : { status: 'offline', config: null, error: error?.message ?? '서버에 연결할 수 없어요' });
    });
    return () => { alive = false; };
  }, [nonce]);

  const retry = useCallback(() => {
    if (!api) return;
    setState((s) => ({ ...s, status: 'checking' }));
    setNonce((n) => n + 1);
  }, []);

  return { ...state, retry };
}

/** 기능별 안내 문구 (null = 사용 가능) */
export function featureBlockedReason(s: ServerConfigState, feature: 'online' | 'generation'): string | null {
  switch (s.status) {
    case 'unconfigured': return '서버 미설정 — 이 배포는 AI 대전·T0 스킨만 지원해요.';
    case 'checking': return '서버 확인 중…';
    case 'offline': return `오프라인: AI 대전만 가능 (${s.error ?? '서버 연결 실패'})`;
    case 'ready':
      if (!s.config?.features[feature]) return feature === 'online' ? '온라인 대전이 서버에서 일시 중지됐어요.' : 'AI 3D 생성이 서버에서 일시 중지됐어요.';
      return null;
  }
}

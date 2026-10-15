'use client';

import { Turnstile as TurnstileWidget } from '@marsidev/react-turnstile';
import { publicEnv } from '@/config/public-env';

interface Props {
  onToken(t: string): void;
  onExpire?(): void;
  resetKey?: number;
}

/** Changing `resetKey` remounts the widget, which gives a fresh token. */
export default function Turnstile({ onToken, onExpire, resetKey = 0 }: Props) {
  return (
    <TurnstileWidget
      key={resetKey}
      siteKey={publicEnv.turnstileSiteKey}
      options={{ theme: 'dark', size: 'flexible' }}
      onSuccess={onToken}
      onExpire={onExpire}
    />
  );
}

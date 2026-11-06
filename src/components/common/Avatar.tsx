import { Avatar as DiceBearAvatar, Style } from '@dicebear/core';
import lorelei from '@dicebear/styles/lorelei.json' with { type: 'json' };
import { useMemo } from 'react';
import { getColor, getPastel } from '@/lib/colors';

const style = new Style(lorelei);

export function Avatar({ seed, size = 128 }: { seed: string; size?: number }) {
  const backgroundColor = getPastel(getColor(seed), 4, '#');

  const avatar = useMemo(() => {
    return new DiceBearAvatar(style, {
      seed,
      size,
      backgroundColor: [backgroundColor],
    }).toDataUri();
  }, [seed, size, backgroundColor]);

  return <img src={avatar} alt="Avatar" style={{ borderRadius: '100%', width: size }} />;
}

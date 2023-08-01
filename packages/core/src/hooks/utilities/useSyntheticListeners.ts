import { useMemo } from 'react';

import type { SyntheticEventName, UniqueIdentifier } from '../../types';

export type SyntheticListener = {
  eventName: SyntheticEventName;
  handler: (event: React.SyntheticEvent, id: UniqueIdentifier) => void;
};

export type SyntheticListeners = SyntheticListener[];

export type SyntheticListenerMap = Record<string, Function>;

// 合成事件
export function useSyntheticListeners(
  listeners: SyntheticListeners,
  id: UniqueIdentifier
): SyntheticListenerMap {
  // 把数组转化成一个 map，返回给调用方 const { listeners } = useDraggable({ //... })
  // return { [enventName]: SyntheticEventFn }
  return useMemo(() => {
    return listeners.reduce<SyntheticListenerMap>(
      (acc, { eventName, handler }) => {
        acc[eventName] = (event: React.SyntheticEvent) => {
          handler(event, id);
        };

        return acc;
      },
      {} as SyntheticListenerMap
    );
  }, [listeners, id]);
}

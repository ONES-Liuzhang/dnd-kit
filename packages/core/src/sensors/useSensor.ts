import { useMemo } from 'react';

import type { Sensor, SensorDescriptor, SensorOptions } from './types';

// useSensor => { sensor: { eventName: 'onXXX', handler: () => void }, options }
export function useSensor<T extends SensorOptions>(
  sensor: Sensor<T>,
  options?: T
): SensorDescriptor<T> {
  return useMemo(
    () => ({
      sensor,
      options: options ?? ({} as T),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sensor, options]
  );
}

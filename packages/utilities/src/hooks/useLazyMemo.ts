import { useMemo, useRef } from 'react';

/**
 * 和 useMemo 类似，区别在于返回值是非响应式的
 * @param callback 
 * @param dependencies 
 * @returns 
 */
export function useLazyMemo<T>(
  callback: (prevValue: T | undefined) => T,
  dependencies: any[]
) {
  const valueRef = useRef<T>();

  return useMemo(
    () => {
      const newValue = callback(valueRef.current);
      valueRef.current = newValue;

      return newValue;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...dependencies]
  );
}

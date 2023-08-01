import React, {
  memo,
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { unstable_batchedUpdates } from 'react-dom';
import {
  add,
  getEventCoordinates,
  getWindow,
  useLatestValue,
  useIsomorphicLayoutEffect,
  useUniqueId,
} from '@dnd-kit/utilities';
import type { Transform } from '@dnd-kit/utilities';

import {
  Action,
  PublicContext,
  InternalContext,
  PublicContextDescriptor,
  InternalContextDescriptor,
  getInitialState,
  reducer,
} from '../../store';
import { DndMonitorContext, useDndMonitorProvider } from '../DndMonitor';
import {
  useAutoScroller,
  useCachedNode,
  useCombineActivators,
  useDragOverlayMeasuring,
  useDroppableMeasuring,
  useInitialRect,
  useRect,
  useRectDelta,
  useRects,
  useScrollableAncestors,
  useScrollOffsets,
  useScrollOffsetsDelta,
  useSensorSetup,
  useWindowRect,
} from '../../hooks/utilities';
import type { AutoScrollOptions, SyntheticListener } from '../../hooks/utilities';
import type {
  Sensor,
  SensorContext,
  SensorDescriptor,
  SensorActivatorFunction,
  SensorInstance,
} from '../../sensors';
import {
  adjustScale,
  CollisionDetection,
  defaultCoordinates,
  getAdjustedRect,
  getFirstCollision,
  rectIntersection,
} from '../../utilities';
import { applyModifiers, Modifiers } from '../../modifiers';
import type { Active, Over } from '../../store/types';
import type {
  DragStartEvent,
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  UniqueIdentifier,
} from '../../types';
import {
  Accessibility,
  Announcements,
  RestoreFocus,
  ScreenReaderInstructions,
} from '../Accessibility';

import { defaultData, defaultSensors } from './defaults';
import {
  useLayoutShiftScrollCompensation,
  useMeasuringConfiguration,
} from './hooks';
import type { MeasuringConfiguration } from './types';

export interface Props {
  id?: string;
  accessibility?: {
    announcements?: Announcements;
    container?: Element;
    restoreFocus?: boolean;
    screenReaderInstructions?: ScreenReaderInstructions;
  };
  autoScroll?: boolean | AutoScrollOptions;
  cancelDrop?: CancelDrop;
  children?: React.ReactNode;
  collisionDetection?: CollisionDetection;
  measuring?: MeasuringConfiguration;
  modifiers?: Modifiers;
  sensors?: SensorDescriptor<any>[];
  onDragStart?(event: DragStartEvent): void;
  onDragMove?(event: DragMoveEvent): void;
  onDragOver?(event: DragOverEvent): void;
  onDragEnd?(event: DragEndEvent): void;
  onDragCancel?(event: DragCancelEvent): void;
}

export interface CancelDropArguments extends DragEndEvent { }

export type CancelDrop = (
  args: CancelDropArguments
) => boolean | Promise<boolean>;

interface DndEvent extends Event {
  dndKit?: {
    capturedBy: Sensor<any>;
  };
}

export const ActiveDraggableContext = createContext<Transform>({
  ...defaultCoordinates,
  scaleX: 1,
  scaleY: 1,
});

enum Status {
  Uninitialized,
  Initializing,
  Initialized,
}

export const DndContext = memo(function DndContext({
  id,
  accessibility,
  autoScroll = true,
  children,
  sensors = defaultSensors,
  collisionDetection = rectIntersection,
  measuring,
  modifiers,
  ...props
}: Props) {
  const store = useReducer(reducer, undefined, getInitialState);
  const [state, dispatch] = store;
  const [dispatchMonitorEvent, registerMonitorListener] =
    useDndMonitorProvider();
  const [status, setStatus] = useState<Status>(Status.Uninitialized);
  const isInitialized = status === Status.Initialized;
  const {
    draggable: { active: activeId, nodes: draggableNodes, translate },
    droppable: { containers: droppableContainers },
  } = state;
  const node = activeId ? draggableNodes.get(activeId) : null;
  const activeRects = useRef<Active['rect']['current']>({
    initial: null,
    translated: null,
  });
  const active = useMemo<Active | null>(
    () =>
      activeId != null
        ? {
          id: activeId,
          // It's possible for the active node to unmount while dragging
          data: node?.data ?? defaultData,
          rect: activeRects,
        }
        : null,
    [activeId, node]
  );
  const activeRef = useRef<UniqueIdentifier | null>(null);
  // 不同的传感器需要切换吗？
  const [activeSensor, setActiveSensor] = useState<SensorInstance | null>(null);
  const [activatorEvent, setActivatorEvent] = useState<Event | null>(null);

  const latestProps = useLatestValue(props, Object.values(props));
  const draggableDescribedById = useUniqueId(`DndDescribedBy`, id);
  // 筛选掉不可用的 -> filter((item) => !item)
  const enabledDroppableContainers = useMemo(
    () => droppableContainers.getEnabled(),
    [droppableContainers]
  );
  const measuringConfiguration = useMeasuringConfiguration(measuring);
  // droppableRects: map => { [uniqId]: rect }
  // measureDroppableContainers: (ids) => void : 计算合法的 Droppable
  const { droppableRects, measureDroppableContainers, measuringScheduled } =
    useDroppableMeasuring(enabledDroppableContainers, {
      dragging: isInitialized,
      dependencies: [translate.x, translate.y],
      config: measuringConfiguration.droppable,
    });
  // 🌟【支持虚拟列表中滚动】拖拽时会对当前节点进行缓存，就算节点被卸载，也会保留引用
  const activeNode = useCachedNode(draggableNodes, activeId);
  // TODO activatorEvent 啥时候初始化？
  const activationCoordinates = useMemo(
    () => (activatorEvent ? getEventCoordinates(activatorEvent) : null),
    [activatorEvent]
  );
  const autoScrollOptions = getAutoScrollerOptions();

  // draggbleMeasure(activeNode) -> activeNode.getBoundingClientRect() 
  // 初始化时为 null
  // 拖拽开始时 activeNode -> initialActiveNodeRect
  const initialActiveNodeRect = useInitialRect(
    activeNode,
    measuringConfiguration.draggable.measure
  );

  // TODO 调整偏移量
  useLayoutShiftScrollCompensation({
    activeNode: activeId ? draggableNodes.get(activeId) : null,
    config: autoScrollOptions.layoutShiftCompensation,
    initialRect: initialActiveNodeRect,
    measure: measuringConfiguration.draggable.measure,
  });

  // 计算 transform
  const activeNodeRect = useRect(
    activeNode,
    measuringConfiguration.draggable.measure,
    initialActiveNodeRect
  );
  const containerNodeRect = useRect(
    activeNode ? activeNode.parentElement : null
  );
  const sensorContext = useRef<SensorContext>({
    activatorEvent: null,
    active: null,
    activeNode,
    collisionRect: null, // 冲突方向
    collisions: null,
    droppableRects, // useDroppable 收集的所有节点的位置坐标
    draggableNodes,
    draggingNode: null,
    draggingNodeRect: null,
    droppableContainers,
    over: null,
    scrollableAncestors: [],
    scrollAdjustedTranslate: null,
  });
  // 获取当前被放置的容器（支持 multiply draggable）
  const overNode = droppableContainers.getNodeFor(
    sensorContext.current.over?.id
  );
  const dragOverlay = useDragOverlayMeasuring({
    measure: measuringConfiguration.dragOverlay.measure,
  });

  // Use the rect of the drag overlay if it is mounted
  // 判断是使用 DragOverlay 还是 activeNode
  const draggingNode = dragOverlay.nodeRef.current ?? activeNode;
  const draggingNodeRect = isInitialized
    ? dragOverlay.rect ?? activeNodeRect
    : null;
  // 是否使用了 DragOverlay
  const usesDragOverlay = Boolean(
    dragOverlay.nodeRef.current && dragOverlay.rect
  );
  // The delta between the previous and new position of the draggable node
  // is only relevant when there is no drag overlay
  // 只有没使用 dragOverlay 的时候，才需要计算偏移量
  const nodeRectDelta = useRectDelta(usesDragOverlay ? null : activeNodeRect);

  // Get the window rect of the dragging node
  const windowRect = useWindowRect(
    draggingNode ? getWindow(draggingNode) : null
  );

  // Get scrollable ancestors of the dragging node
  // 获取滚动容器
  const scrollableAncestors = useScrollableAncestors(
    isInitialized ? overNode ?? activeNode : null
  );
  // 滚动容器尺寸
  const scrollableAncestorRects = useRects(scrollableAncestors);

  // Apply modifiers
  // translate: store.state.draggable.translate 状态树中存储的拖拽元素坐标
  const modifiedTranslate = applyModifiers(modifiers, {
    transform: {
      x: translate.x - nodeRectDelta.x,
      y: translate.y - nodeRectDelta.y,
      scaleX: 1,
      scaleY: 1,
    },
    activatorEvent,
    active,
    activeNodeRect,
    containerNodeRect,
    draggingNodeRect,
    over: sensorContext.current.over,
    overlayNodeRect: dragOverlay.rect,
    scrollableAncestors,
    scrollableAncestorRects,
    windowRect,
  });

  // add: value + valueAdjustment，把调整对象中每一项累加到目标对象的对应项中
  const pointerCoordinates = activationCoordinates
    ? add(activationCoordinates, translate)
    : null;

  const scrollOffsets = useScrollOffsets(scrollableAncestors);
  // Represents the scroll delta since dragging was initiated
  const scrollAdjustment = useScrollOffsetsDelta(scrollOffsets);
  // Represents the scroll delta since the last time the active node rect was measured
  const activeNodeScrollDelta = useScrollOffsetsDelta(scrollOffsets, [
    activeNodeRect,
  ]);

  const scrollAdjustedTranslate = add(modifiedTranslate, scrollAdjustment);

  // 碰撞计算
  // 通过碰撞计算，可以算出当前的 over node
  const collisionRect = draggingNodeRect
    ? getAdjustedRect(draggingNodeRect, modifiedTranslate)
    : null;

  const collisions =
    active && collisionRect
      ? collisionDetection({
        active,
        collisionRect,
        droppableRects,
        droppableContainers: enabledDroppableContainers,
        pointerCoordinates,
      })
      : null;
  const overId = getFirstCollision(collisions, 'id');
  const [over, setOver] = useState<Over | null>(null);

  // When there is no drag overlay used, we need to account for the
  // window scroll delta
  const appliedTranslate = usesDragOverlay
    ? modifiedTranslate
    : add(modifiedTranslate, activeNodeScrollDelta);

  const transform = adjustScale(
    appliedTranslate,
    over?.rect ?? null,
    activeNodeRect
  );

  const instantiateSensor = useCallback(
    (
      event: React.SyntheticEvent,
      { sensor: Sensor, options }: SensorDescriptor<any>
    ) => {
      if (activeRef.current == null) {
        return;
      }

      // draggableNodes -> 调用 useDraggable 时会收集所有 draggableNodes
      const activeNode = draggableNodes.get(activeRef.current);

      if (!activeNode) {
        return;
      }

      const activatorEvent = event.nativeEvent;

      // 鼠标传感器实例
      const sensorInstance = new Sensor({
        active: activeRef.current,
        activeNode,
        event: activatorEvent,
        options,
        // Sensors need to be instantiated with refs for arguments that change over time
        // otherwise they are frozen in time with the stale arguments
        context: sensorContext,
        onStart(initialCoordinates) {
          const id = activeRef.current;

          if (id == null) {
            return;
          }

          const draggableNode = draggableNodes.get(id);

          if (!draggableNode) {
            return;
          }

          const { onDragStart } = latestProps.current;
          const event: DragStartEvent = {
            active: { id, data: draggableNode.data, rect: activeRects },
          };

          unstable_batchedUpdates(() => {
            onDragStart?.(event);
            setStatus(Status.Initializing);
            dispatch({
              type: Action.DragStart,
              initialCoordinates,
              active: id,
            });
            dispatchMonitorEvent({ type: 'onDragStart', event });
          });
        },
        onMove(coordinates) {
          dispatch({
            type: Action.DragMove,
            coordinates,
          });
        },
        onEnd: createHandler(Action.DragEnd),
        onCancel: createHandler(Action.DragCancel),
      });

      unstable_batchedUpdates(() => {
        // 设置当前传感器示例
        setActiveSensor(sensorInstance);
        setActivatorEvent(event.nativeEvent);
      });

      function createHandler(type: Action.DragEnd | Action.DragCancel) {
        return async function handler() {
          const { active, collisions, over, scrollAdjustedTranslate } =
            sensorContext.current;
          let event: DragEndEvent | null = null;

          if (active && scrollAdjustedTranslate) {
            const { cancelDrop } = latestProps.current;

            event = {
              activatorEvent,
              active: active,
              collisions,
              delta: scrollAdjustedTranslate,
              over,
            };

            if (type === Action.DragEnd && typeof cancelDrop === 'function') {
              const shouldCancel = await Promise.resolve(cancelDrop(event));

              if (shouldCancel) {
                type = Action.DragCancel;
              }
            }
          }

          activeRef.current = null;

          unstable_batchedUpdates(() => {
            dispatch({ type });
            setStatus(Status.Uninitialized);
            setOver(null);
            setActiveSensor(null);
            setActivatorEvent(null);

            const eventName =
              type === Action.DragEnd ? 'onDragEnd' : 'onDragCancel';

            if (event) {
              const handler = latestProps.current[eventName];

              handler?.(event);
              dispatchMonitorEvent({ type: eventName, event });
            }
          });
        };
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draggableNodes]
  );

  // 把 Sensor.handler
  const bindActivatorToSensorInstantiator = useCallback(
    (
      handler: SensorActivatorFunction<any>,
      sensor: SensorDescriptor<any>
    ): SyntheticListener['handler'] => {
      // event => React 合成事件
      // active => activeID 当前元素 id => 调用方自己配的 useDraggable({ id })
      return (event, active) => {
        const nativeEvent = event.nativeEvent as DndEvent;
        const activeDraggableNode = draggableNodes.get(active);

        if (
          // Another sensor is already instantiating
          activeRef.current !== null ||
          // No active draggable
          !activeDraggableNode ||
          // Event has already been captured
          nativeEvent.dndKit ||
          nativeEvent.defaultPrevented
        ) {
          return;
        }

        const activationContext = {
          active: activeDraggableNode,
        };
        const shouldActivate = handler(
          event,
          sensor.options,
          activationContext
        );

        if (shouldActivate === true) {
          nativeEvent.dndKit = {
            capturedBy: sensor.sensor,
          };

          activeRef.current = active;
          instantiateSensor(event, sensor);
        }
      };
    },
    [draggableNodes, instantiateSensor]
  );

  // 使用 bindActivatorToSensorInstantiator 对 sensors handler 做一层格式化
  const activators = useCombineActivators(
    sensors,
    bindActivatorToSensorInstantiator
  );

  useSensorSetup(sensors);

  useIsomorphicLayoutEffect(() => {
    if (activeNodeRect && status === Status.Initializing) {
      setStatus(Status.Initialized);
    }
  }, [activeNodeRect, status]);

  useEffect(
    () => {
      const { onDragMove } = latestProps.current;
      const { active, activatorEvent, collisions, over } = sensorContext.current;

      if (!active || !activatorEvent) {
        return;
      }

      const event: DragMoveEvent = {
        active,
        activatorEvent,
        collisions,
        delta: {
          x: scrollAdjustedTranslate.x,
          y: scrollAdjustedTranslate.y,
        },
        over,
      };

      unstable_batchedUpdates(() => {
        onDragMove?.(event);
        dispatchMonitorEvent({ type: 'onDragMove', event });
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrollAdjustedTranslate.x, scrollAdjustedTranslate.y]
  );

  useEffect(
    () => {
      const {
        active,
        activatorEvent,
        collisions,
        droppableContainers,
        scrollAdjustedTranslate,
      } = sensorContext.current;

      if (
        !active ||
        activeRef.current == null ||
        !activatorEvent ||
        !scrollAdjustedTranslate
      ) {
        return;
      }

      const { onDragOver } = latestProps.current;
      const overContainer = droppableContainers.get(overId);
      const over =
        overContainer && overContainer.rect.current
          ? {
            id: overContainer.id,
            rect: overContainer.rect.current,
            data: overContainer.data,
            disabled: overContainer.disabled,
          }
          : null;
      const event: DragOverEvent = {
        active,
        activatorEvent,
        collisions,
        delta: {
          x: scrollAdjustedTranslate.x,
          y: scrollAdjustedTranslate.y,
        },
        over,
      };

      unstable_batchedUpdates(() => {
        setOver(over);
        onDragOver?.(event);
        dispatchMonitorEvent({ type: 'onDragOver', event });
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overId]
  );

  useIsomorphicLayoutEffect(() => {
    sensorContext.current = {
      activatorEvent,
      active,
      activeNode,
      collisionRect,
      collisions,
      droppableRects,
      draggableNodes,
      draggingNode,
      draggingNodeRect,
      droppableContainers,
      over,
      scrollableAncestors,
      scrollAdjustedTranslate,
    };

    activeRects.current = {
      initial: draggingNodeRect,
      translated: collisionRect,
    };
  }, [
    active,
    activeNode,
    collisions,
    collisionRect,
    draggableNodes,
    draggingNode,
    draggingNodeRect,
    droppableRects,
    droppableContainers,
    over,
    scrollableAncestors,
    scrollAdjustedTranslate,
  ]);

  useAutoScroller({
    ...autoScrollOptions,
    delta: translate,
    draggingRect: collisionRect,
    pointerCoordinates,
    scrollableAncestors,
    scrollableAncestorRects,
  });

  // 暴露给外部的 state
  const publicContext = useMemo(() => {
    const context: PublicContextDescriptor = {
      active,
      activeNode,
      activeNodeRect,
      activatorEvent,
      collisions,
      containerNodeRect,
      dragOverlay,
      draggableNodes,
      droppableContainers,
      droppableRects,
      over,
      measureDroppableContainers,
      scrollableAncestors,
      scrollableAncestorRects,
      measuringConfiguration,
      measuringScheduled,
      windowRect,
    };

    return context;
  }, [
    active,
    activeNode,
    activeNodeRect,
    activatorEvent,
    collisions,
    containerNodeRect,
    dragOverlay,
    draggableNodes,
    droppableContainers,
    droppableRects,
    over,
    measureDroppableContainers,
    scrollableAncestors,
    scrollableAncestorRects,
    measuringConfiguration,
    measuringScheduled,
    windowRect,
  ]);

  const internalContext = useMemo(() => {
    const context: InternalContextDescriptor = {
      activatorEvent,
      activators,
      active,
      activeNodeRect,
      ariaDescribedById: {
        draggable: draggableDescribedById,
      },
      dispatch,
      draggableNodes,
      over,
      measureDroppableContainers,
    };

    return context;
  }, [
    activatorEvent,
    activators,
    active,
    activeNodeRect,
    dispatch,
    draggableDescribedById,
    draggableNodes,
    over,
    measureDroppableContainers,
  ]);

  return (
    <DndMonitorContext.Provider value={registerMonitorListener}>
      <InternalContext.Provider value={internalContext}>
        <PublicContext.Provider value={publicContext}>
          <ActiveDraggableContext.Provider value={transform}>
            {children}
          </ActiveDraggableContext.Provider>
        </PublicContext.Provider>
        <RestoreFocus disabled={accessibility?.restoreFocus === false} />
      </InternalContext.Provider>
      <Accessibility
        {...accessibility}
        hiddenTextDescribedById={draggableDescribedById}
      />
    </DndMonitorContext.Provider>
  );

  function getAutoScrollerOptions() {
    const activeSensorDisablesAutoscroll =
      activeSensor?.autoScrollEnabled === false;
    const autoScrollGloballyDisabled =
      typeof autoScroll === 'object'
        ? autoScroll.enabled === false
        : autoScroll === false;
    const enabled =
      isInitialized &&
      !activeSensorDisablesAutoscroll &&
      !autoScrollGloballyDisabled;

    if (typeof autoScroll === 'object') {
      return {
        ...autoScroll,
        enabled,
      };
    }

    return { enabled };
  }
});

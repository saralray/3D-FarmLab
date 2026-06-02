import { ReactNode, useRef } from 'react';
import { Responsive, WidthProvider, type Layout, type Layouts } from 'react-grid-layout';
import { GripVertical } from 'lucide-react';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  ANALYTICS_CARD_LABELS,
  ANALYTICS_CARD_MIN_SIZE,
  ANALYTICS_GRID_COLS,
  type AnalyticsCardId,
  type AnalyticsLayout,
  type AnalyticsLayoutItem,
} from '../lib/analyticsLayoutApi';
import { cn } from './ui/utils';

// WidthProvider measures the container and feeds `width` to Responsive; create
// it once at module scope so it isn't rebuilt on every render.
const ResponsiveGridLayout = WidthProvider(Responsive);

const DRAG_HANDLE_CLASS = 'analytics-card-drag-handle';

interface AnalyticsCardGridProps {
  layout: AnalyticsLayout;
  cards: Record<AnalyticsCardId, ReactNode>;
  editable: boolean;
  /** Drag/resize finished — persist the new lg layout. */
  onCommit: (next: AnalyticsLayout) => void;
}

// Smaller breakpoints reduce the column count so cards stack instead of
// shrinking into unreadable slivers; react-grid-layout derives those layouts
// from the stored `lg` arrangement.
const BREAKPOINTS = { lg: 1024, md: 768, sm: 640, xs: 480, xxs: 0 };
const COLS = { lg: ANALYTICS_GRID_COLS, md: ANALYTICS_GRID_COLS, sm: 4, xs: 2, xxs: 1 };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Area (in grid cells) where two rectangles overlap; 0 when they don't touch.
function overlapArea(a: Rect, b: Rect): number {
  const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return xOverlap * yOverlap;
}

export function AnalyticsCardGrid({ layout, cards, editable, onCommit }: AnalyticsCardGridProps) {
  // Fold each card's minimum size into the layout so resizing can't shrink a
  // chart below a legible size.
  const withMins: Layout[] = layout.map((item) => ({
    ...item,
    minW: ANALYTICS_CARD_MIN_SIZE[item.i].w,
    minH: ANALYTICS_CARD_MIN_SIZE[item.i].h,
  }));
  // Store one canonical layout under `lg`; react-grid-layout derives the
  // narrower breakpoints from it for display.
  const layouts: Layouts = { lg: withMins };

  // Track the active column count so edits made on a narrow (sm/xs/xxs)
  // breakpoint, whose coordinates aren't valid as the canonical 10-column
  // layout, are not persisted. WidthProvider corrects this on mount via
  // onBreakpointChange before any drag can happen.
  const colsRef = useRef(ANALYTICS_GRID_COLS);

  const toAnalyticsLayout = (items: Layout[]): AnalyticsLayout =>
    items.map(({ i, x, y, w, h }) => ({ i: i as AnalyticsCardId, x, y, w, h }));

  // Persist a settled layout (a free move or a resize) unless it came from a
  // narrow breakpoint or is somehow empty.
  const persist = (items: Layout[]) => {
    if (!editable || colsRef.current !== ANALYTICS_GRID_COLS || items.length === 0) {
      return;
    }
    onCommit(toAnalyticsLayout(items));
  };

  const handleDragStop = (settledLayout: Layout[], oldItem: Layout, newItem: Layout) => {
    if (!editable || colsRef.current !== ANALYTICS_GRID_COLS) {
      return;
    }
    // Where the card was released, keeping its own size (size doesn't change
    // while dragging). Compare against the pre-drag layout to find the card it
    // was dropped onto.
    const droppedRect: Rect = { x: newItem.x, y: newItem.y, w: oldItem.w, h: oldItem.h };
    let target: AnalyticsLayoutItem | null = null;
    let bestArea = 0;
    for (const item of layout) {
      if (item.i === newItem.i) {
        continue;
      }
      const area = overlapArea(droppedRect, item);
      if (area > bestArea) {
        bestArea = area;
        target = item;
      }
    }

    const dragged = layout.find((item) => item.i === newItem.i);
    if (target && dragged && bestArea > 0) {
      // Switch the two cards: each takes the other's exact slot, so the grid
      // stays gap-free regardless of their sizes. (const captures so the values
      // stay narrowed to non-null inside the map closure.)
      const from = dragged;
      const onto = target;
      const swapped: AnalyticsLayout = layout.map((item) => {
        if (item.i === from.i) {
          return { ...item, x: onto.x, y: onto.y, w: onto.w, h: onto.h };
        }
        if (item.i === onto.i) {
          return { ...item, x: from.x, y: from.y, w: from.w, h: from.h };
        }
        return item;
      });
      onCommit(swapped);
      return;
    }

    // Released on empty space — keep the freely moved position.
    persist(settledLayout);
  };

  const handleResizeStop = (settledLayout: Layout[]) => {
    persist(settledLayout);
  };

  return (
    <ResponsiveGridLayout
      className="layout"
      layouts={layouts}
      breakpoints={BREAKPOINTS}
      cols={COLS}
      rowHeight={40}
      margin={[16, 16]}
      containerPadding={[0, 0]}
      isDraggable={editable}
      isResizable={editable}
      draggableHandle={`.${DRAG_HANDLE_CLASS}`}
      onBreakpointChange={(_breakpoint, newCols) => {
        colsRef.current = newCols;
      }}
      onDragStop={handleDragStop}
      onResizeStop={handleResizeStop}
      resizeHandles={['se']}
    >
      {layout.map((item) => {
        return (
          <div
            key={item.i}
            className={cn(
              'h-full',
              editable && 'rounded-xl ring-2 ring-blue-400/50 ring-offset-2 ring-offset-transparent dark:ring-offset-gray-900',
            )}
          >
            {editable && (
              <button
                type="button"
                className={cn(
                  DRAG_HANDLE_CLASS,
                  'absolute left-2 top-2 z-10 flex size-8 cursor-grab touch-none items-center justify-center rounded-md border border-gray-200 bg-white/90 text-gray-500 shadow-sm backdrop-blur transition-colors hover:bg-gray-100 active:cursor-grabbing dark:border-gray-600 dark:bg-gray-900/80 dark:text-gray-300 dark:hover:bg-gray-700',
                )}
                aria-label={`Drag ${ANALYTICS_CARD_LABELS[item.i]} card`}
              >
                <GripVertical className="size-4" />
              </button>
            )}
            {cards[item.i]}
          </div>
        );
      })}
    </ResponsiveGridLayout>
  );
}

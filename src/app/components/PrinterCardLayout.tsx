import { ReactNode, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { CARD_LABELS, type CardId, type CardLayout } from '../lib/cardLayoutApi';
import { cn } from './ui/utils';

interface PrinterCardLayoutProps {
  layout: CardLayout;
  cards: Partial<Record<CardId, ReactNode>>;
  editable: boolean;
  /** Live update during a drag — update state only, do not persist. */
  onChange: (next: CardLayout) => void;
  /** Drag finished — persist the result. */
  onCommit: (next: CardLayout) => void;
}

function columnDroppableId(index: number) {
  return `col-${index}`;
}

function findColumnIndex(layout: CardLayout, id: string): number {
  if (id.startsWith('col-')) {
    return Number(id.slice('col-'.length));
  }
  return layout.findIndex((column) => column.includes(id as CardId));
}

function SortableCard({ id, children }: { id: CardId; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={cn('relative', isDragging && 'opacity-40')}>
      <button
        type="button"
        className="absolute right-2 top-2 z-10 flex size-8 cursor-grab touch-none items-center justify-center rounded-md border border-gray-200 bg-white/90 text-gray-500 shadow-sm backdrop-blur transition-colors hover:bg-gray-100 active:cursor-grabbing dark:border-gray-600 dark:bg-gray-900/80 dark:text-gray-300 dark:hover:bg-gray-700"
        aria-label={`Drag ${CARD_LABELS[id]} card`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <div className="rounded-xl ring-2 ring-blue-400/50 ring-offset-2 ring-offset-transparent dark:ring-offset-gray-900">
        {children}
      </div>
    </div>
  );
}

function DroppableColumn({
  index,
  children,
}: {
  index: number;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(index) });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'space-y-6 rounded-xl border-2 border-dashed p-2 transition-colors',
        isOver ? 'border-blue-400 bg-blue-50/40 dark:bg-blue-500/10' : 'border-gray-200 dark:border-gray-700',
      )}
    >
      {children}
    </div>
  );
}

export function PrinterCardLayout({ layout, cards, editable, onChange, onCommit }: PrinterCardLayoutProps) {
  const [activeId, setActiveId] = useState<CardId | null>(null);
  // Handlers read the freshest layout from a ref so cross-column moves applied
  // during a single drag don't operate on a stale render.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Non-editable: render the plain 3-column grid, identical to the read view.
  if (!editable) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {layout.map((column, columnIndex) => (
          <div key={`col-${columnIndex}`} className="space-y-6">
            {column.map((id) => cards[id] && <div key={id}>{cards[id]}</div>)}
          </div>
        ))}
      </div>
    );
  }

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as CardId);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) {
      return;
    }

    const current = layoutRef.current;
    const activeColumn = findColumnIndex(current, String(active.id));
    const overColumn = findColumnIndex(current, String(over.id));

    if (activeColumn === -1 || overColumn === -1 || activeColumn === overColumn) {
      return;
    }

    const next = current.map((column) => [...column]) as CardLayout;
    next[activeColumn] = next[activeColumn].filter((id) => id !== active.id);

    const overIsColumn = String(over.id).startsWith('col-');
    const overIndex = overIsColumn ? next[overColumn].length : next[overColumn].indexOf(over.id as CardId);
    next[overColumn].splice(overIndex >= 0 ? overIndex : next[overColumn].length, 0, active.id as CardId);

    onChange(next);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    const current = layoutRef.current;
    if (over && !String(over.id).startsWith('col-')) {
      const column = findColumnIndex(current, String(active.id));
      if (column !== -1 && findColumnIndex(current, String(over.id)) === column) {
        const oldIndex = current[column].indexOf(active.id as CardId);
        const newIndex = current[column].indexOf(over.id as CardId);
        if (oldIndex !== newIndex && newIndex !== -1) {
          const next = current.map((col) => [...col]) as CardLayout;
          next[column] = arrayMove(next[column], oldIndex, newIndex);
          onCommit(next);
          return;
        }
      }
    }

    // Cross-column moves were already applied live in handleDragOver.
    onCommit(current);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {layout.map((column, columnIndex) => {
          // Only ids whose card is actually available are sortable/rendered;
          // hidden ids (e.g. an unsupported light) keep their slot in `layout`.
          const visibleItems = column.filter((id) => cards[id]);
          return (
            <DroppableColumn key={`col-${columnIndex}`} index={columnIndex}>
              <SortableContext items={visibleItems} strategy={verticalListSortingStrategy}>
                {visibleItems.map((id) => (
                  <SortableCard key={id} id={id}>
                    {cards[id]}
                  </SortableCard>
                ))}
              </SortableContext>
            </DroppableColumn>
          );
        })}
      </div>
      <DragOverlay>
        {activeId ? (
          <div className="rounded-xl border border-blue-400 bg-white px-4 py-3 text-sm font-semibold text-gray-700 shadow-lg dark:bg-gray-800 dark:text-gray-200">
            {CARD_LABELS[activeId]}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

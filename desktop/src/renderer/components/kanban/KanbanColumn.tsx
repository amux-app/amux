import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { KanbanColumn as KanbanColumnType } from '../../hooks/useKanbanColumns';
import { KanbanCard, getCardId } from './KanbanCard';
import { cn } from '../../lib/cn';

interface KanbanColumnProps {
  column: KanbanColumnType;
  selectedCardId: string | null;
  onCardClick: (cardId: string) => void;
  onCardAction?: (cardId: string, action: string) => void;
  footerAction?: { label: string; onClick: () => void; variant?: 'default' | 'accent' };
  secondaryAction?: { label: string; onClick: () => void };
}

export function KanbanColumn({
  column,
  selectedCardId,
  onCardClick,
  onCardAction,
  footerAction,
  secondaryAction,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    disabled: !column.droppable,
    data: {
      kind: 'kanban-column',
      columnId: column.id,
    },
  });

  const cardIds = column.items.map(getCardId);

  return (
    <div
      ref={setNodeRef}
      data-testid={`kanban-column-${column.id}`}
      className={cn(
        'flex flex-col min-w-[260px] max-w-[320px] flex-1 min-h-0 rounded-lg transition-colors duration-200',
        isOver && column.droppable && 'bg-[var(--accent)]/5 ring-1 ring-inset ring-[var(--accent)]/20',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 shrink-0">
        <span
          className="h-2 w-2 rounded-full shrink-0"
          style={{ backgroundColor: column.color }}
        />
        <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          {column.title}
        </span>
        <span
          data-testid={`kanban-column-count-${column.id}`}
          className="text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none"
          style={{
            backgroundColor: column.items.length > 0 ? `color-mix(in srgb, ${column.color} 15%, transparent)` : 'var(--surface)',
            color: column.items.length > 0 ? column.color : 'var(--text-muted)',
          }}
        >
          {column.items.length}
        </span>
        {secondaryAction && (
          <button
            onClick={secondaryAction.onClick}
            className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {secondaryAction.label}
          </button>
        )}
      </div>

      <div
        className={cn(
          'flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-1.5 min-h-0 rounded-lg mx-1 transition-colors duration-200',
        )}
      >
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {column.items.map((item) => {
            const id = getCardId(item);
            return (
              <div key={id}>
                <KanbanCard
                  item={item}
                  columnId={column.id}
                  isSelected={selectedCardId === id}
                  onClick={() => onCardClick(id)}
                  onAction={onCardAction ? (action) => onCardAction(id, action) : undefined}
                  draggable={column.draggableCards && item.type !== 'launching' && item.type !== 'done'}
                />
              </div>
            );
          })}
        </SortableContext>

        {column.items.length === 0 && (
          <div className="flex items-center justify-center py-8 text-[11px] text-[var(--text-muted)]">
            {column.droppable || column.draggableCards ? 'Drop items here' : 'No items'}
          </div>
        )}
      </div>

      {footerAction && (
        <div className="px-3 py-2 shrink-0">
          <button
            onClick={footerAction.onClick}
            className={cn(
              'w-full py-1.5 rounded-md text-[11px] font-medium transition-all duration-150',
              footerAction.variant === 'accent'
                ? 'bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 border border-[var(--accent)]/20'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] border border-transparent hover:border-[var(--border)]',
            )}
          >
            {footerAction.label}
          </button>
        </div>
      )}
    </div>
  );
}

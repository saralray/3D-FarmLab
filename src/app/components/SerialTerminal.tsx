import { useEffect, useRef } from 'react';
import { ScrollArea } from './ui/scroll-area';

interface SerialTerminalProps {
  // The full accumulated serial output. New text is appended by the caller;
  // this component just renders it and keeps the view pinned to the bottom.
  content: string;
  className?: string;
  emptyHint?: string;
}

// Read-only scrolling terminal for a device's serial output. Auto-scrolls to
// the newest line as `content` grows (used by the status-light serial monitor
// and the flash dialog's live output).
export function SerialTerminal({ content, className, emptyHint }: SerialTerminalProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [content]);

  return (
    <ScrollArea className={`h-64 rounded-md border bg-black/90 ${className ?? ''}`}>
      <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-green-300">
        {content || <span className="text-green-300/50">{emptyHint ?? 'Waiting for serial output…'}</span>}
      </pre>
      <div ref={bottomRef} />
    </ScrollArea>
  );
}

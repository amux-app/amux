import type { AgentName } from 'muxbase/core';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type CSSProperties, type ReactNode, useId, useState } from 'react';
import { cn } from '../../lib/cn';
import { AGENT_INFO } from './AgentSelector';

interface ConfigurationDisclosureProps {
  agent: AgentName;
  children: ReactNode;
  summary: string;
}

export function ConfigurationDisclosure({ agent, children, summary }: ConfigurationDisclosureProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const brand = AGENT_INFO[agent].brand;

  return (
    <div className="flex flex-col" style={{ '--agent-brand': brand } as CSSProperties}>
      <button
        type="button"
        aria-controls={panelId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex w-full items-center gap-2.5 border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] px-3.5 py-3 text-left transition-colors',
          open ? 'rounded-t-xl border-b-transparent bg-[linear-gradient(180deg,color-mix(in_srgb,var(--agent-brand)_8%,transparent),transparent)]' : 'rounded-xl',
          'hover:border-[var(--divider-strong)] hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--agent-brand)_55%,transparent)]',
        )}
      >
        <SlidersHorizontal className={cn('h-[15px] w-[15px] shrink-0', open ? 'text-[var(--agent-brand)]' : 'text-[var(--text-secondary)]')} />
        <span className="text-xs font-semibold text-[var(--text)]">Configuration</span>
        <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">{summary}</span>
        <ChevronDown className={cn('ml-auto h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform duration-200', open && 'rotate-180')} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="relative overflow-hidden rounded-b-xl border border-t-0 border-[var(--divider)]"
          >
            <div aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-[color-mix(in_srgb,var(--agent-brand)_55%,transparent)]" />
            <div className="flex flex-col gap-2.5 px-3 py-3 pl-3.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

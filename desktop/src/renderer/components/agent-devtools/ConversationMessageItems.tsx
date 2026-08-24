import React, { useEffect, useRef, useState } from 'react';
import {
  Brain,
  BrainCircuit,
  Check,
  ChevronRight,
  Copy,
  User,
} from 'lucide-react';
import { getUsageSnapshot } from '../../../shared/agent-session-display-metrics';
import type { CompactionEvent, NormalizedMessage, NormalizedToolCall, NormalizedToolResult, SubagentSession } from '../../../shared/agent-session-types';
import { clipboardWrite } from '../../api/system.api';
import { activateOnEnterOrSpace } from '../../lib/aria-button';
import { formatTokenCount } from '../../lib/formatters';
import { getToolColor, getToolVisual, SUBAGENT_COLOR } from '../../lib/tool-visuals';
import { ProseMarkdown } from '../shared/ProseMarkdown';
import { BashToolViewer } from './tool-viewers/BashToolViewer';
import { DefaultToolViewer } from './tool-viewers/DefaultToolViewer';
import { EditToolViewer } from './tool-viewers/EditToolViewer';
import { ReadToolViewer } from './tool-viewers/ReadToolViewer';
import { TaskToolViewer } from './tool-viewers/TaskToolViewer';
import { WriteToolViewer } from './tool-viewers/WriteToolViewer';

const COPY_STYLE_SUCCESS = { color: 'var(--success)' } as const;
const COPY_STYLE_MUTED = { color: 'var(--tool-item-muted)' } as const;

interface MessageGroupProps {
  message: NormalizedMessage;
  paneId?: string;
  subagentMap: Map<string, SubagentSession>;
  toolResultMap: Map<string, NormalizedToolResult>;
}

export function MessageGroup({
  message, paneId, subagentMap, toolResultMap,
}: MessageGroupProps) {
  if (message.type === 'user') return <UserBubble message={message} />;
  if (message.type === 'system') return <SystemRow message={message} />;

  return (
    <div className="space-y-1">
      {message.thinkingContent && (
        <ThinkingRow content={message.thinkingContent} tokens={message.tokens} />
      )}

      {message.content && (
        <div className="relative group">
          <div className="text-sm leading-relaxed" style={{ color: 'var(--prose-body)' }}>
            <ProseMarkdown content={message.content} />
          </div>
          <div className="absolute top-0 right-0">
            <CopyButton text={message.content} />
          </div>
        </div>
      )}

      {message.toolCalls.map(tc => (
        <ToolRow
          key={tc.id}
          paneId={paneId}
          subagent={subagentMap.get(tc.id)}
          subagentMap={subagentMap}
          toolCall={tc}
          toolResult={toolResultMap.get(tc.id)}
          toolResultMap={toolResultMap}
        />
      ))}
    </div>
  );
}

export function CompactionMarker({ event }: { event: CompactionEvent }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex-1 h-px" style={{ backgroundColor: 'var(--warning)', opacity: 0.3 }} />
      <span className="text-[9px] font-mono shrink-0 px-2 py-0.5 rounded-full" style={{
        color: 'var(--warning)',
        backgroundColor: 'color-mix(in srgb, var(--warning) 10%, transparent)',
      }}>
        Context compacted: {formatTokenCount(event.tokensBefore)} → {formatTokenCount(event.tokensAfter)}
      </span>
      <div className="flex-1 h-px" style={{ backgroundColor: 'var(--warning)', opacity: 0.3 }} />
    </div>
  );
}

function UserBubble({ message }: { message: NormalizedMessage }) {
  if (!message.content) return null;

  const time = message.timestamp
    ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="flex justify-start group">
      <div className="max-w-[85%] space-y-1.5">
        <div className="flex items-center gap-1.5">
          <User size={12} style={{ color: 'var(--tool-item-summary)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--tool-item-summary)' }}>You</span>
          {time && (
            <span className="text-[10px]" style={{ color: 'var(--tool-item-muted)' }}>{time}</span>
          )}
          <CopyButton text={message.content} />
        </div>

        <div
          className="rounded-2xl rounded-bl-sm px-4 py-3"
          style={{
            backgroundColor: 'var(--chat-user-bg)',
            border: '1px solid var(--chat-user-border)',
            boxShadow: 'var(--chat-user-shadow)',
          }}
        >
          <div className="text-sm leading-relaxed" style={{ color: 'var(--chat-user-text)' }}>
            <ProseMarkdown content={message.content} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SystemRow({ message }: { message: NormalizedMessage }) {
  const [expanded, setExpanded] = useState(false);
  if (!message.content) return null;

  return (
    <div>
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
        className="flex items-center gap-1.5 text-[10px] py-1"
        style={{ color: 'var(--tool-item-muted)' }}
      >
        <span>System prompt</span>
        <ChevronRight
          size={10}
          style={{
            transition: 'transform 0.15s',
            transform: expanded ? 'rotate(90deg)' : 'none',
          }}
        />
      </button>
      {expanded && (
        <div
          className="rounded-lg px-3 py-2 max-h-[100px] overflow-y-auto"
          style={{
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border)',
          }}
        >
          <pre className="text-[10px] font-sans whitespace-pre-wrap" style={{ color: 'var(--tool-item-summary)' }}>
            {message.content}
          </pre>
        </div>
      )}
    </div>
  );
}

function ThinkingRow({ content, tokens }: { content: string; tokens?: NormalizedMessage['tokens'] }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.slice(0, 80).replace(/\n/g, ' ');
  const tokenCount = tokens ? (getUsageSnapshot(tokens)?.totalUsageTokens ?? 0) : 0;

  return (
    <div>
      <ItemRow
        expanded={expanded}
        icon={<Brain size={16} />}
        label="Thinking"
        onToggle={() => setExpanded(v => !v)}
        summary={preview}
        tokenCount={tokenCount > 0 ? tokenCount : undefined}
      />
      {expanded && (
        <div
          className="ml-2 mt-2 pl-6 space-y-3"
          style={{ borderLeft: '2px solid var(--border)' }}
        >
          <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--tool-item-summary)' }}>
            {content}
          </p>
        </div>
      )}
    </div>
  );
}

function ToolRow({
  paneId, subagent, subagentMap, toolCall, toolResult, toolResultMap,
}: {
  paneId?: string;
  subagent?: SubagentSession;
  subagentMap: Map<string, SubagentSession>;
  toolCall: NormalizedToolCall;
  toolResult?: NormalizedToolResult;
  toolResultMap: Map<string, NormalizedToolResult>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [subExpanded, setSubExpanded] = useState(false);
  const ToolIcon = getToolVisual(toolCall.name).icon;
  const color = getToolColor(toolCall.name, toolResult?.isError);
  const Viewer = getToolViewer(toolCall.name);

  return (
    <div>
      <ItemRow
        durationMs={toolResult?.durationMs}
        expanded={expanded}
        icon={<ToolIcon size={14} style={{ color }} />}
        isError={toolResult?.isError}
        label={toolCall.name}
        labelColor={color}
        onToggle={() => setExpanded(v => !v)}
        summary={getToolSummary(toolCall)}
      />
      {expanded && (
        <div
          className="ml-2 mt-2 pl-6 space-y-3"
          style={{ borderLeft: '2px solid var(--border)' }}
        >
          <Viewer paneId={paneId} toolCall={toolCall} toolResult={toolResult} />
        </div>
      )}
      {subagent && subagent.messages.length > 0 && (
        <SubagentSection
          expanded={subExpanded}
          onToggle={() => setSubExpanded(v => !v)}
          paneId={paneId}
          subagent={subagent}
          subagentMap={subagentMap}
          toolResultMap={toolResultMap}
        />
      )}
    </div>
  );
}

function ItemRow({
  durationMs, expanded, icon, isError, label, labelColor, onToggle, summary, tokenCount,
}: {
  durationMs?: number;
  expanded: boolean;
  icon: React.ReactNode;
  isError?: boolean;
  label: string;
  labelColor?: string;
  onToggle: () => void;
  summary?: string;
  tokenCount?: number;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      onKeyDown={activateOnEnterOrSpace(onToggle)}
      className="group flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 transition-colors"
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--tool-item-hover-bg)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
      style={{ backgroundColor: 'transparent' }}
    >
      <span className="size-3.5 shrink-0 flex items-center justify-center" style={{ color: 'var(--tool-item-muted)' }}>
        {icon}
      </span>

      <span
        className="text-xs font-medium shrink-0"
        style={{ color: labelColor ?? 'var(--tool-item-name)' }}
      >
        {label}
      </span>

      {summary && (
        <>
          <span className="text-xs shrink-0" style={{ color: 'var(--tool-item-muted)' }}>-</span>
          <span className="flex-1 truncate text-xs font-mono" style={{ color: 'var(--tool-item-summary)' }}>
            {summary}
          </span>
        </>
      )}

      {!summary && <span className="flex-1" />}

      {tokenCount != null && tokenCount > 0 && (
        <span
          className="shrink-0 rounded px-1 py-px text-[10px]"
          style={{ color: 'var(--tool-item-muted)', backgroundColor: 'var(--surface)' }}
        >
          ~{formatTokenCount(tokenCount)} tokens
        </span>
      )}

      {isError && (
        <span className="text-[10px] font-semibold shrink-0" style={{ color: 'var(--error)' }}>ERR</span>
      )}

      {durationMs != null && (
        <span className="text-[10px] shrink-0" style={{ color: 'var(--tool-item-muted)' }}>
          {formatMs(durationMs)}
        </span>
      )}

      <ChevronRight
        size={10}
        className="shrink-0"
        style={{
          color: 'var(--tool-item-muted)',
          transition: 'transform 0.15s',
          transform: expanded ? 'rotate(90deg)' : 'none',
        }}
      />
    </div>
  );
}

function SubagentSection({
  expanded, onToggle, paneId, subagent, subagentMap, toolResultMap,
}: {
  expanded: boolean;
  onToggle: () => void;
  paneId?: string;
  subagent: SubagentSession;
  subagentMap: Map<string, SubagentSession>;
  toolResultMap: Map<string, NormalizedToolResult>;
}) {
  return (
    <div className="ml-4 mt-1">
      <ItemRow
        expanded={expanded}
        icon={<BrainCircuit size={12} />}
        label="Subagent"
        labelColor={SUBAGENT_COLOR}
        onToggle={onToggle}
        summary={buildSubagentSummary(subagent)}
        tokenCount={subagent.metrics.totalTokens > 0 ? subagent.metrics.totalTokens : undefined}
      />
      {expanded && (
        <div
          className="ml-2 mt-1 pl-4 space-y-4 py-2"
          style={{ borderLeft: `2px solid ${SUBAGENT_COLOR}33` }}
        >
          {subagent.messages.map(msg => (
            <MessageGroup
              key={msg.id}
              message={msg}
              paneId={paneId}
              subagentMap={subagentMap}
              toolResultMap={toolResultMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void clipboardWrite(text);
    setCopied(true);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  return (
    <button
      onClick={handleCopy}
      className="opacity-60 hover:opacity-100 transition-opacity p-1 rounded bg-[var(--surface)] hover:bg-[var(--surface-raised)]"
      aria-label="Copy to clipboard"
      title="Copy message as markdown"
    >
      {copied
        ? <Check size={14} style={COPY_STYLE_SUCCESS} />
        : <Copy size={14} style={COPY_STYLE_MUTED} />}
    </button>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}.${Math.floor((ms % 1000) / 100)}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function getToolViewer(name: string) {
  switch (name) {
    case 'Bash':  return BashToolViewer;
    case 'Edit':  return EditToolViewer;
    case 'Read':  return ReadToolViewer;
    case 'Task':  return TaskToolViewer;
    case 'Write': return WriteToolViewer;
    default:      return DefaultToolViewer;
  }
}

function getToolSummary(toolCall: NormalizedToolCall): string {
  const { input, name } = toolCall;
  switch (name) {
    case 'Edit':
    case 'Read':
    case 'Write':
      return getStringInput(input.file_path);
    case 'Bash':
      return getStringInput(input.command).slice(0, 80);
    default:
      return Object.keys(input).join(', ');
  }
}

function buildSubagentSummary(subagent: SubagentSession): string {
  const parts: string[] = [`${subagent.messages.length} msgs`];
  if (subagent.metrics.toolCallCount > 0) parts.push(`${subagent.metrics.toolCallCount} tools`);
  if (subagent.description) parts.push(subagent.description.slice(0, 80));
  return parts.join(' · ');
}

function getStringInput(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

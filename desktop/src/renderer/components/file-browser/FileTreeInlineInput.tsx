import { useEffect, useRef } from 'react';

interface FileTreeInlineInputProps {
  defaultValue?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function normalizeSubmittedValue(defaultValue: string | undefined, value: string): string {
  const dotIndex = defaultValue?.lastIndexOf('.') ?? -1;
  if (!defaultValue || dotIndex <= 0) {
    return value;
  }

  const extension = defaultValue.slice(dotIndex);
  const duplicatedExtension = `${extension}${extension}`;
  return value.endsWith(duplicatedExtension) ? value.slice(0, -extension.length) : value;
}

export function FileTreeInlineInput({ defaultValue, onSubmit, onCancel }: FileTreeInlineInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleSubmit = (value: string) => {
    const submittedValue = normalizeSubmittedValue(defaultValue, value);
    if (submitted.current || !submittedValue || submittedValue === defaultValue) return;
    submitted.current = true;
    onSubmit(submittedValue);
  };

  return (
    <input
      ref={inputRef}
      data-testid="file-tree-inline-input"
      defaultValue={defaultValue}
      className="min-w-0 flex-1 rounded border border-(--accent) bg-(--surface) px-1 py-0 text-[12px] text-(--text) outline-none"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const val = e.currentTarget.value.trim();
          if (val && val !== defaultValue) handleSubmit(val);
          else onCancel();
        }
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={(e) => {
        const val = e.currentTarget.value.trim();
        if (val && val !== defaultValue) {
          handleSubmit(val);
        } else {
          onCancel();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => {
        const name = e.currentTarget.value;
        const dotIndex = name.lastIndexOf('.');
        e.currentTarget.setSelectionRange(0, dotIndex > 0 ? dotIndex : name.length);
      }}
    />
  );
}

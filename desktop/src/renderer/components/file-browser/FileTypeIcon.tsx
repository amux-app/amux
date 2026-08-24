import type { CSSProperties } from 'react';
import spriteMarkup from '../../assets/file-icons/generated/file-icon-sprite.svg?raw';
import { cn } from '../../lib/cn';
import type { FileIconRef } from '../../lib/fileIcons';

const DEFAULT_ICON_SIZE = 14;

/** Keeps the sprite in the document without contributing layout or paint. */
const SPRITE_HOST_STYLE: CSSProperties = {
  height: 0,
  overflow: 'hidden',
  position: 'absolute',
  width: 0,
};

export function FileIconSprite() {
  return (
    <div
      aria-hidden
      data-testid="file-icon-sprite"
      dangerouslySetInnerHTML={{ __html: spriteMarkup }}
      style={SPRITE_HOST_STYLE}
    />
  );
}

interface FileTypeIconProps {
  className?: string;
  color?: string;
  icon: FileIconRef;
  size?: number;
}

export function FileTypeIcon({ className, color, icon, size = DEFAULT_ICON_SIZE }: FileTypeIconProps) {
  return (
    <svg
      aria-hidden
      className={cn('shrink-0', className)}
      data-icon-symbol={icon.symbolId}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: color ?? icon.color }}
      width={size}
    >
      <use href={`#${icon.symbolId}`} />
    </svg>
  );
}

export interface MinimalDocumentChange {
  from: number;
  insert: string;
  to: number;
}

export function computeMinimalDocumentChange(
  currentContent: string,
  nextContent: string,
): MinimalDocumentChange | null {
  if (currentContent === nextContent) {
    return null;
  }

  const sharedLimit = Math.min(currentContent.length, nextContent.length);
  let sharedPrefixLength = 0;
  while (
    sharedPrefixLength < sharedLimit
    && currentContent.charCodeAt(sharedPrefixLength) === nextContent.charCodeAt(sharedPrefixLength)
  ) {
    sharedPrefixLength += 1;
  }

  const remainingCurrentLength = currentContent.length - sharedPrefixLength;
  const remainingNextLength = nextContent.length - sharedPrefixLength;
  const suffixLimit = Math.min(remainingCurrentLength, remainingNextLength);
  let sharedSuffixLength = 0;
  while (
    sharedSuffixLength < suffixLimit
    && currentContent.charCodeAt(currentContent.length - sharedSuffixLength - 1)
      === nextContent.charCodeAt(nextContent.length - sharedSuffixLength - 1)
  ) {
    sharedSuffixLength += 1;
  }

  return {
    from: sharedPrefixLength,
    insert: nextContent.slice(sharedPrefixLength, nextContent.length - sharedSuffixLength),
    to: currentContent.length - sharedSuffixLength,
  };
}

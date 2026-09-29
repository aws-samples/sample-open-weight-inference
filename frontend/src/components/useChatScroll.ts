import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Follow new text only while the reader remains near the bottom. */
export function useChatScroll(content: unknown) {
  const threadRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [hasNewText, setHasNewText] = useState(false);
  const onScroll = useCallback(() => {
    const node = threadRef.current;
    if (!node) return;
    following.current = node.scrollHeight - node.clientHeight - node.scrollTop < 80;
    if (following.current) setHasNewText(false);
  }, []);
  const jumpToLatest = useCallback(() => {
    following.current = true;
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    setHasNewText(false);
  }, []);
  useLayoutEffect(() => {
    if (following.current) jumpToLatest();
    else setHasNewText(true);
  }, [content, jumpToLatest]);
  return { threadRef, onScroll, hasNewText, jumpToLatest };
}

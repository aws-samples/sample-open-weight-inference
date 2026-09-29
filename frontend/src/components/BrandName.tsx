import { Fragment, type ReactNode } from 'react';

/**
 * Mirror the second D from the current font instead of substituting a Unicode
 * character from another font. The spoken/copyable name stays ordinary EDDIE.
 */
export function BrandName() {
  return (
    <span className="eddie-brand-name">
      <span className="eddie-brand-accessible">EDDIE</span>
      <span className="eddie-brand-visible" aria-hidden="true">
        ED<span className="eddie-brand-mirrored-d">D</span>IE
      </span>
    </span>
  );
}

/** Apply the text mark to display copy; never use this on IDs, URLs or code. */
export function brandText(text: string): ReactNode {
  const parts = text.split(/(\bEDDIE\b)/g);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    part === 'EDDIE' ? <BrandName key={index} /> : <Fragment key={index}>{part}</Fragment>
  );
}

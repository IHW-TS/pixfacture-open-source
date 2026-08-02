"use client";

import type { ReactNode } from "react";

type Props = {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  templateKey?: string; // classic | graphite | ivory (ou autre)
};

export default function PaperSheet({ title, subtitle, children, className, templateKey }: Props) {
  const templateClass = templateKey ? `paper-template--${templateKey}` : "";
  return (
    <section
      className={`paper-sheet ${templateClass} ${className || ""}`.trim()}
      aria-label={title || "Document"}
      data-paper-template={templateKey || undefined}
    >
      {title || subtitle ? (
        <header className="paper-sheet__header">
          <div>
            {title ? <div className="paper-sheet__title">{title}</div> : null}
            {subtitle ? <div className="paper-sheet__subtitle">{subtitle}</div> : null}
          </div>
        </header>
      ) : null}
      <div className="paper-sheet__body">{children}</div>
    </section>
  );
}

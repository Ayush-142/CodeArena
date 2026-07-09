'use client';

import ReactMarkdown from 'react-markdown';

// Deliberately no plugins — react-markdown renders straight to React elements and never
// calls dangerouslySetInnerHTML by default, so raw HTML in statementMd (e.g. <script>) is
// inert text, not executed. Do NOT add the rehype-raw plugin: that is what turns this from
// "safe by construction" into "safe only if sanitized", and there's no sanitizer wired up.
export function MarkdownStatement({ statementMd }: { statementMd: string }) {
  return (
    <div className="max-w-none font-body text-ink [&_code]:rounded [&_code]:bg-surface [&_code]:font-mono [&_code]:text-sm [&_h1]:font-display [&_h1]:text-lg [&_h1]:font-bold [&_h2]:font-display [&_h2]:font-bold [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-line [&_pre]:bg-surface [&_pre]:p-2 [&_pre]:font-mono [&_pre]:text-sm [&_a]:text-accent [&_a]:underline">
      <ReactMarkdown>{statementMd}</ReactMarkdown>
    </div>
  );
}

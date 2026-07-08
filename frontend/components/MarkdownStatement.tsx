'use client';

import ReactMarkdown from 'react-markdown';

// Deliberately no plugins — react-markdown renders straight to React elements and never
// calls dangerouslySetInnerHTML by default, so raw HTML in statementMd (e.g. <script>) is
// inert text, not executed. Do NOT add the rehype-raw plugin: that is what turns this from
// "safe by construction" into "safe only if sanitized", and there's no sanitizer wired up.
export function MarkdownStatement({ statementMd }: { statementMd: string }) {
  return (
    <div className="max-w-none [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_pre]:bg-slate-800 [&_pre]:p-2 [&_code]:bg-slate-800">
      <ReactMarkdown>{statementMd}</ReactMarkdown>
    </div>
  );
}

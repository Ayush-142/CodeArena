'use client';

import Editor from '@monaco-editor/react';
import { JUDGE_SLIP_MONACO_THEME, defineJudgeSlipTheme } from '@/lib/monacoTheme';

// Only cpp is enabled — the server hard-rejects any other `language` value
// (api/src/routes/submissions.ts), so a real multi-option selector would be dishonest.
export function MonacoEditorPanel({
  code,
  onChange,
}: {
  code: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="panel-header flex items-center justify-between">
        <span>Editor</span>
        <select value="cpp" disabled className="rounded-md border border-line bg-canvas px-2 py-1 text-xs font-mono normal-case text-ink">
          <option value="cpp">C++</option>
        </select>
      </div>
      <Editor
        height="400px"
        language="cpp"
        theme={JUDGE_SLIP_MONACO_THEME}
        beforeMount={defineJudgeSlipTheme}
        value={code}
        onChange={(value) => onChange(value ?? '')}
        options={{ fontFamily: 'var(--font-mono)', fontLigatures: false }}
      />
    </div>
  );
}

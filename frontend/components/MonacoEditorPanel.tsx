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
    <div>
      <label className="mb-2 block font-mono text-sm text-ink">
        Language:{' '}
        <select value="cpp" disabled className="border border-line bg-transparent p-1 text-ink">
          <option value="cpp">C++</option>
        </select>
      </label>
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

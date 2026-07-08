'use client';

import Editor from '@monaco-editor/react';

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
      <label className="mb-2 block text-sm">
        Language:{' '}
        <select value="cpp" disabled className="border border-slate-600 bg-transparent p-1">
          <option value="cpp">C++</option>
        </select>
      </label>
      <Editor
        height="400px"
        language="cpp"
        theme="vs-dark"
        value={code}
        onChange={(value) => onChange(value ?? '')}
      />
    </div>
  );
}

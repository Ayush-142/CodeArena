import type { Monaco } from '@monaco-editor/react';

// Matches the "Judge Slip" token system (tailwind.config.ts) — kept in one place so
// MonacoEditorPanel and the /styleguide route stay in sync.
export const JUDGE_SLIP_MONACO_THEME = 'judge-slip';

export function defineJudgeSlipTheme(monaco: Monaco): void {
  monaco.editor.defineTheme(JUDGE_SLIP_MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '4FA875', fontStyle: 'italic' },
      { token: 'keyword', foreground: '5B90C4', fontStyle: 'bold' },
      { token: 'number', foreground: 'C98A3B' },
      { token: 'string', foreground: '4FA875' },
      { token: 'type', foreground: 'F2F2F2' },
      { token: 'identifier', foreground: 'F2F2F2' },
      { token: 'delimiter', foreground: 'ADADAD' },
    ],
    colors: {
      'editor.background': '#141414',
      'editor.foreground': '#F2F2F2',
      'editorLineNumber.foreground': '#6B6B6B',
      'editorLineNumber.activeForeground': '#F2F2F2',
      'editor.lineHighlightBackground': '#1C1C1C',
      'editorCursor.foreground': '#5B90C4',
      'editorIndentGuide.background': '#2A2A2A',
      'editor.selectionBackground': '#5B90C44D',
      'editorWidget.background': '#1C1C1C',
      'editorWidget.border': '#ADADAD',
    },
  });
}

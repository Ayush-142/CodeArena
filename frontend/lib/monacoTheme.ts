import type { Monaco } from '@monaco-editor/react';

// Matches the "Judge Slip" token system (tailwind.config.ts) — kept in one place so
// MonacoEditorPanel and the /styleguide route stay in sync.
export const JUDGE_SLIP_MONACO_THEME = 'judge-slip';

export function defineJudgeSlipTheme(monaco: Monaco): void {
  monaco.editor.defineTheme(JUDGE_SLIP_MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8A8F94', fontStyle: 'italic' },
      { token: 'keyword', foreground: '3E7CB8' },
      { token: 'number', foreground: 'C98A3B' },
      { token: 'string', foreground: '4FA875' },
      { token: 'type', foreground: 'E4E7E6' },
      { token: 'identifier', foreground: 'E4E7E6' },
      { token: 'delimiter', foreground: '8A8F94' },
    ],
    colors: {
      'editor.background': '#0E1113',
      'editor.foreground': '#E4E7E6',
      'editorLineNumber.foreground': '#3A4045',
      'editorLineNumber.activeForeground': '#E4E7E6',
      'editor.lineHighlightBackground': '#171B1E',
      'editorCursor.foreground': '#3E7CB8',
      'editorIndentGuide.background': '#3A4045',
      'editor.selectionBackground': '#3E7CB84D',
      'editorWidget.background': '#171B1E',
      'editorWidget.border': '#3A4045',
    },
  });
}

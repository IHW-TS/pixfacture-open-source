"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

export type EmailTemplateVariableItem = {
  token: string;
  label: string;
  value: string;
};

type EmailBodyPart =
  | { type: "text"; text: string; key: string }
  | { type: "variable"; text: string; item: EmailTemplateVariableItem; start: number; end: number; key: string };

type SelectedVariable = Extract<EmailBodyPart, { type: "variable" }> & {
  _selected?: true;
};

const editorClassName =
  "h-[360px] w-full overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-300 bg-white px-3 py-3 text-[13px] leading-6 text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 lg:h-[420px]";

const cleanupBodySpacing = (value: string) =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const textToHtml = (value: string) => escapeHtml(value).replace(/\n/g, "<br>");

function buildEmailBodyParts(value: string, variables: EmailTemplateVariableItem[]) {
  const usableVariables = variables
    .map((item) => ({ ...item, value: String(item.value || "").trim() }))
    .filter((item) => item.value.length >= 2)
    .sort((left, right) => right.value.length - left.value.length);
  const parts: EmailBodyPart[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    let match: { item: EmailTemplateVariableItem; index: number } | null = null;
    for (const item of usableVariables) {
      const index = value.indexOf(item.value, cursor);
      if (index === -1) continue;
      if (!match || index < match.index || (index === match.index && item.value.length > match.item.value.length)) {
        match = { item, index };
      }
    }
    if (!match) {
      parts.push({ type: "text", text: value.slice(cursor), key: `text-${cursor}-${value.length}` });
      break;
    }
    if (match.index > cursor) {
      parts.push({ type: "text", text: value.slice(cursor, match.index), key: `text-${cursor}-${match.index}` });
    }
    const end = match.index + match.item.value.length;
    parts.push({
      type: "variable",
      text: match.item.value,
      item: match.item,
      start: match.index,
      end,
      key: `var-${match.item.token}-${match.index}-${end}`,
    });
    cursor = end;
  }
  return parts;
}

function renderEditorHtml(parts: EmailBodyPart[]) {
  return parts
    .map((part) => {
      if (part.type === "text") return textToHtml(part.text);
      return `<button type="button" data-variable-start="${part.start}" data-variable-end="${part.end}" class="email-variable-token" title="${escapeHtml(
        `${part.item.label} : cliquer pour remplacer ou supprimer`,
      )}">${escapeHtml(part.text)}</button>`;
    })
    .join("");
}

export function EmailBodyEditor({
  value,
  onChange,
  variableItems,
  placeholder = "Message",
}: {
  value: string;
  onChange: (value: string) => void;
  variableItems: EmailTemplateVariableItem[];
  placeholder?: string;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef(false);
  const lastEmittedValueRef = useRef(value);
  const [selected, setSelected] = useState<SelectedVariable | null>(null);
  const parts = useMemo(() => buildEmailBodyParts(value, variableItems), [value, variableItems]);
  const editorHtml = useMemo(() => renderEditorHtml(parts), [parts]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (focusedRef.current && value === lastEmittedValueRef.current) return;
    editor.innerHTML = editorHtml || "";
  }, [editorHtml, value]);

  const emitFromEditor = (nextValue: string) => {
    const next = nextValue.replace(/\r\n/g, "\n");
    lastEmittedValueRef.current = next;
    onChange(next);
  };

  const replaceSelected = (replacement: string) => {
    if (!selected) return;
    const next = cleanupBodySpacing(`${value.slice(0, selected.start)}${replacement}${value.slice(selected.end)}`);
    onChange(next);
    setSelected(null);
    window.setTimeout(() => editorRef.current?.focus(), 0);
  };

  return (
    <div className="relative space-y-2">
      <div
        ref={editorRef}
        className={editorClassName}
        role="textbox"
        aria-label={placeholder}
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={(event) => {
          focusedRef.current = false;
          const next = cleanupBodySpacing(event.currentTarget.innerText || "");
          if (next !== value) {
            lastEmittedValueRef.current = next;
            onChange(next);
          }
          event.currentTarget.innerHTML = renderEditorHtml(buildEmailBodyParts(next, variableItems));
        }}
        onInput={(event) => {
          setSelected(null);
          emitFromEditor(event.currentTarget.innerText || "");
        }}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          const selection = window.getSelection();
          if (!selection?.rangeCount) return;
          selection.deleteFromDocument();
          const range = selection.getRangeAt(0);
          range.insertNode(document.createTextNode(text));
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
          emitFromEditor(event.currentTarget.innerText || "");
        }}
        onClick={(event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const button = target.closest<HTMLButtonElement>("[data-variable-start][data-variable-end]");
          if (!button) return;
          event.preventDefault();
          const start = Number(button.dataset.variableStart);
          const end = Number(button.dataset.variableEnd);
          const part = parts.find(
            (candidate): candidate is Extract<EmailBodyPart, { type: "variable" }> =>
              candidate.type === "variable" && candidate.start === start && candidate.end === end,
          );
          if (part) {
            setSelected({ ...part, _selected: true });
            return;
          }
          const buttonText = button.innerText.trim();
          const fallbackItem = variableItems.find((item) => item.value === buttonText);
          const fallbackStart = value.indexOf(buttonText);
          if (fallbackItem && fallbackStart >= 0) {
            setSelected({
              type: "variable",
              text: buttonText,
              item: fallbackItem,
              start: fallbackStart,
              end: fallbackStart + buttonText.length,
              key: `var-${fallbackItem.token}-${fallbackStart}-${fallbackStart + buttonText.length}`,
              _selected: true,
            });
          }
        }}
      />

      {selected ? (
        <div
          className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-[12px] text-slate-700 shadow-sm"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 font-semibold">
              <span className="text-slate-500">{selected.item.label}</span>{" "}
              <span className="font-extrabold text-blue-800">{selected.text}</span>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-red-100 bg-white px-2.5 py-1 font-bold text-red-600 hover:bg-red-50"
              onClick={() => replaceSelected("")}
            >
              <X className="h-3.5 w-3.5" />
              Supprimer
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {variableItems
              .filter((item) => item.value && item.value !== selected.text)
              .map((item) => (
                <button
                  key={`${selected.key}-${item.token}`}
                  type="button"
                  className="rounded-full border border-blue-200 bg-white px-2.5 py-1 font-bold text-blue-700 hover:bg-slate-50"
                  onClick={() => replaceSelected(item.value)}
                >
                  Remplacer par {item.label.toLowerCase()}
                </button>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

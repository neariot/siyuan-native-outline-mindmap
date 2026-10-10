import React, { useEffect, useRef } from 'react';
import { renderFormula } from './katex';
import type { OutlineNode } from '../../model/types';
import { TASK_DONE, TASK_TODO } from '../../model/types';
import { htmlToText } from '../../model/tree';
import { getImageUrl } from './images';
import { t } from '../i18n';

/** Render HTML content: KaTeX formulas, local images, mentions, noderefs. */
export function RichContent({
  html,
  onOpenMention,
  onOpenNoderef,
}: {
  html: string;
  onOpenMention?: (docId: string) => void;
  onOpenNoderef?: (target: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // render formulas
    el.querySelectorAll<HTMLElement>('[data-formula]').forEach((s) => {
      const src = s.getAttribute('data-formula') || '';
      void renderFormula(src, s);
    });
    // resolve local images
    el.querySelectorAll<HTMLImageElement>('img[data-img]').forEach((img) => {
      const id = img.getAttribute('data-img');
      if (!id) return;
      getImageUrl(id).then((url) => {
        if (url) img.src = url;
      });
    });
    // mention & noderef click navigation
    const onClick = (e: Event) => {
      // ★ The variable is named target rather than t -- `t` is this module's i18n lookup function and must not be shadowed
      const target = e.target as HTMLElement;
      const m = target.closest('[data-mention]');
      if (m && onOpenMention) onOpenMention(m.getAttribute('data-mention') || '');
      const nr = target.closest('[data-noderef]');
      if (nr && onOpenNoderef) onOpenNoderef(nr.getAttribute('data-noderef') || '');
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [html, onOpenMention, onOpenNoderef]);

  return <div className="rich-inner" ref={ref} dangerouslySetInnerHTML={{ __html: html || '' }} />;
}

export function FormulaBadge({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) void renderFormula(latex, ref.current);
  }, [latex]);
  return (
    <span className="formula" title={latex}>
      <span ref={ref} />{' '}
    </span>
  );
}

/** Inline plain label for mindmap/export: formula -> $..$, img -> [image]. */
export function labelOf(n: OutlineNode): string {
  const s = htmlToText(n.text).trim();
  return s || t('lblEmptyNode');
}

export function TaskBox({
  status,
  onCycle,
}: {
  status?: number;
  onCycle: () => void;
}) {
  const checked = status === TASK_DONE;
  return (
    <span className="taskbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={onCycle}
        onClick={(e) => e.stopPropagation()}
        title={
          status === TASK_TODO
            ? t('tipTaskTodoClickDone')
            : t('tipTaskMarkDone')
        }
      />
    </span>
  );
}

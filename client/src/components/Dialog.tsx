import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Modal built on the native <dialog> element, which provides focus trapping, Escape to close
 * and an inert background for free.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-rule bg-surface p-0 text-ink shadow-xl backdrop:bg-ink/40"
    >
      <div className="flex items-center justify-between border-b border-rule px-5 py-3">
        <h2 className="text-lg font-bold">{title}</h2>
        <button type="button" onClick={onClose} className="rounded px-2 text-xl text-muted hover:text-ink" aria-label="Close">
          ×
        </button>
      </div>
      <div className="px-5 py-4">{children}</div>
    </dialog>
  );
}

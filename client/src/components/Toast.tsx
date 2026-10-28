import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Tone = 'success' | 'error';
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);

/**
 * Short-lived messages in the corner. Errors carry the server's own explanation of why a move was
 * refused ("This shift is already filled (4 of 4 spots taken)."), so they stay up longer.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const show = useCallback((message: string, tone: Tone = 'success') => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={`max-w-md rounded-md border px-4 py-3 text-sm shadow-lg ${
              toast.tone === 'error'
                ? 'border-danger/30 bg-danger-tint text-danger'
                : 'border-rule bg-ink text-white'
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside <ToastProvider>');
  return show;
}

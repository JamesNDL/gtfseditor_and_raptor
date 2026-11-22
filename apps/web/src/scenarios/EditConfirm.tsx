import { useEffect, useState } from 'react';
import { cancelConfirm, confirmEdit } from './scenario-client.ts';
import { useStore } from '../app/store.ts';
import './scenarios.css';

/**
 * Asks before a change that would add many vehicles. The server has worked the change out and
 * thrown it away again: nothing is applied until "Go ahead" is pressed.
 */
export function EditConfirm() {
  const pending = useStore((s) => s.editConfirm);
  // True once "Go ahead" has been pressed, while the change is applied.
  const [going, setGoing] = useState(false);

  useEffect(() => {
    setGoing(false);
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancelConfirm();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  if (!pending) return null;
  return (
    <div className="fleet-backdrop" onClick={() => !going && cancelConfirm()}>
      <section
        className="panel edit-confirm"
        role="alertdialog"
        aria-label="Add these vehicles?"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>This adds {pending.added.toLocaleString()} vehicles</h2>
        <p>{pending.message}</p>
        <p className="muted small">What the change does: {pending.summary}</p>
        <p className="muted small">
          Nothing has been changed yet. It can also be undone afterwards.
        </p>
        <div className="edit-confirm-buttons">
          <button className="button confirm-cancel" onClick={cancelConfirm} disabled={going}>
            Cancel
          </button>
          <button
            className="button confirm-go"
            disabled={going}
            onClick={() => {
              setGoing(true);
              confirmEdit();
            }}
          >
            {going ? 'Applying ...' : 'Go ahead'}
          </button>
        </div>
      </section>
    </div>
  );
}

// One saved zone or point of interest in the setup's lists: a box to pick it, Rename and Delete.
// Delete asks once more first.
import { useState } from 'react';
import { NameForm } from './NameForm.tsx';

interface Props {
  name: string;
  /** 'zone' or 'point of interest', for the buttons' tips. */
  what: string;
  /** A zone is one of several (a radio button); points of interest are ticked (a checkbox). */
  pick: 'radio' | 'checkbox';
  /** The radio group's name. */
  group: string;
  picked: boolean;
  onPick: () => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
  /** Shown while something else is being done, so that only one thing happens at once. */
  disabled?: boolean;
}

export function PlaceRow({
  name,
  what,
  pick,
  group,
  picked,
  onPick,
  onRename,
  onDelete,
  disabled = false,
}: Props) {
  const [mode, setMode] = useState<'show' | 'rename' | 'delete'>('show');
  const [error, setError] = useState<string | null>(null);

  if (mode === 'rename') {
    return (
      <li className="analysis-place">
        <NameForm
          label={`New name for the ${what}`}
          initial={name}
          onSave={async (next) => {
            await onRename(next);
            setMode('show');
          }}
          onCancel={() => setMode('show')}
        />
      </li>
    );
  }

  return (
    <li className="analysis-place">
      <label className="analysis-place-name">
        <input type={pick} name={group} checked={picked} disabled={disabled} onChange={onPick} />
        <span className="ellipsis" title={name}>
          {name}
        </span>
      </label>
      <div className="analysis-actions">
        {mode === 'show' ? (
          <>
            <button
              className="button small-button"
              disabled={disabled}
              title={`Give this ${what} a new name`}
              onClick={() => setMode('rename')}
            >
              Rename
            </button>
            <button
              className="button small-button"
              disabled={disabled}
              title={`Delete this ${what}; analyses already run keep their own copy`}
              onClick={() => setMode('delete')}
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <button
              className="button small-button danger"
              onClick={() =>
                onDelete().catch((e: Error) => {
                  setMode('show');
                  setError(e.message);
                })
              }
            >
              Delete for good
            </button>
            <button className="button small-button" onClick={() => setMode('show')}>
              Keep
            </button>
          </>
        )}
      </div>
      {error && <p className="error-text small analysis-place-error">{error}</p>}
    </li>
  );
}

// A name box with Save and Cancel, for naming or renaming a zone or a point of interest. Enter
// saves and Escape cancels. A save that fails keeps the box open with the API's words.
import { useState } from 'react';

interface Props {
  /** What the box is for, read out by screen readers and shown as its placeholder. */
  label: string;
  initial?: string;
  saveText?: string;
  onSave: (name: string) => Promise<void> | void;
  onCancel: () => void;
}

export function NameForm({ label, initial = '', saveText = 'Save', onSave, onCancel }: Props) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const save = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="analysis-name-form">
      <input
        className="day-select analysis-name-input"
        autoFocus
        value={name}
        placeholder={label}
        aria-label={label}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') {
            // The map's own Escape would stop the drawing too; this box only.
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="analysis-actions">
        <button
          className="button small-button"
          disabled={!trimmed || busy}
          onClick={() => void save()}
        >
          {saveText}
        </button>
        <button className="button small-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

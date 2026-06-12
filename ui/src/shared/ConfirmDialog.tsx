// A small modal confirmation, shared by both shells. Like the dashboard, it
// uses the desktop token names and a `.m-app` remap (in theme.css) renders it in
// the mobile palette, so one component serves both. Used to gate manual runs of
// a runbook flagged `confirm:` (destructive/irreversible).
export function ConfirmDialog({ title, message, confirmLabel = 'Run', cancelLabel = 'Cancel', danger = false, onConfirm, onCancel, children }: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;   // optional extras under the message (e.g. a checkbox)
}) {
  return (
    <div className="confirm-back" onClick={onCancel}>
      <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-h" data-danger={danger}>{title}</div>
        <p className="confirm-msg">{message}</p>
        {children}
        <div className="confirm-actions">
          <button className="confirm-btn" onClick={onCancel}>{cancelLabel}</button>
          <button className={`confirm-btn ${danger ? 'confirm-danger' : 'confirm-go'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

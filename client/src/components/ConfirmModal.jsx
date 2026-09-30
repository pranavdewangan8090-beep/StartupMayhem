import Modal from './Modal.jsx';

/**
 * A "are you sure?" step for actions that can't be undone from the app
 * (triggering a crisis, deactivating a team, processing a trade, resetting a
 * password). `children` describes exactly what will happen.
 */
export default function ConfirmModal({ title, children, confirmLabel = 'Confirm', danger = false, busy, onConfirm, onCancel }) {
  return (
    <Modal onClose={busy ? undefined : onCancel}>
      <h2>{title}</h2>
      {children}
      <div className="row" style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} disabled={busy} onClick={onCancel}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} style={{ flex: 1 }} disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

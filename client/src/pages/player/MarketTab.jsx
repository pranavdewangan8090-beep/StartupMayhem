import { useEffect, useState } from 'react';
import { api, newRequestId, ApiError } from '../../lib/api.js';
import { useToast } from '../../lib/ToastContext.jsx';
import Modal from '../../components/Modal.jsx';

export default function MarketTab({ gameState, onChanged }) {
  const [subtab, setSubtab] = useState('listings');
  const [listings, setListings] = useState({ mine: [], others: [] });
  const [tradable, setTradable] = useState([]);
  const [received, setReceived] = useState([]);
  const [offerFor, setOfferFor] = useState(null); // listing
  const [chosenCardId, setChosenCardId] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function loadAll() {
    const [l, t, r] = await Promise.all([
      api.get('/market/listings'),
      api.get('/market/my-tradable-cards'),
      api.get('/market/offers/received'),
    ]);
    setListings(l);
    setTradable(t);
    setReceived(r);
  }
  useEffect(() => { loadAll(); }, [gameState?.pending_trade_offers_in]);

  async function unlist(listingId) {
    setBusy(true);
    try {
      await api.post('/market/unlist', { listingId, requestId: newRequestId() });
      toast('Card unlisted.', 'info');
      await loadAll();
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not unlist.', 'error');
    } finally { setBusy(false); }
  }

  async function makeOffer() {
    if (!chosenCardId) return;
    setBusy(true);
    try {
      await api.post('/market/offer', { listingId: offerFor.listing_id, offeredTeamActionCardId: chosenCardId, requestId: newRequestId() });
      toast('Trade offer sent!', 'success');
      setOfferFor(null);
      setChosenCardId('');
      await loadAll();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not send offer.', 'error');
    } finally { setBusy(false); }
  }

  async function respondOffer(offerId, accept) {
    setBusy(true);
    try {
      await api.post('/market/offers/respond', { offerId, accept, requestId: newRequestId() });
      toast(accept ? 'Trade completed!' : 'Offer rejected.', accept ? 'success' : 'info');
      await loadAll();
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not respond.', 'error');
    } finally { setBusy(false); }
  }

  if (!gameState?.marketplace_open) {
    return <div className="empty-state">The marketplace is currently closed. Check back once the Super Admin opens it.</div>;
  }

  return (
    <div>
      <div className="tabbar" style={{ position: 'static', top: 'auto' }}>
        <button className={subtab === 'listings' ? 'active' : ''} onClick={() => setSubtab('listings')}>Marketplace</button>
        <button className={subtab === 'received' ? 'active' : ''} onClick={() => setSubtab('received')}>
          Requests Received {received.length > 0 && `(${received.length})`}
        </button>
      </div>

      {subtab === 'listings' && (
        <div className="section">
          <h2 style={{ marginTop: 16 }}>Your Listings</h2>
          {listings.mine.length === 0 && <p>You have nothing listed.</p>}
          {listings.mine.map((l) => (
            <div key={l.listing_id} className={`action-card-tile cat-${l.category}`} style={{ marginBottom: 10 }}>
              <div className="name">{l.name}</div>
              <div className="effect">{l.effect_text}</div>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => unlist(l.listing_id)}>Unlist</button>
            </div>
          ))}

          <h2 style={{ marginTop: 20 }}>Other Teams' Listings</h2>
          {listings.others.length === 0 && <p>Nothing listed yet.</p>}
          {listings.others.map((l) => (
            <div key={l.listing_id} className={`action-card-tile cat-${l.category}`} style={{ marginBottom: 10 }}>
              <span className="pill" style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}>from {l.seller_team_code}</span>
              <div className="name" style={{ marginTop: 6 }}>{l.name}</div>
              <div className="effect">{l.effect_text}</div>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setOfferFor(l)}>Offer a Trade</button>
            </div>
          ))}
        </div>
      )}

      {subtab === 'received' && (
        <div className="section">
          {received.length === 0 && <p>No trade requests yet.</p>}
          {received.map((o) => (
            <div key={o.offer_id} className="card-surface" style={{ marginBottom: 10 }}>
              <div><b>{o.buyer_team_code}</b> offers <b>{o.offered_card_name}</b> for your <b>{o.listed_card_name}</b></div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn btn-success btn-sm" disabled={busy} onClick={() => respondOffer(o.offer_id, true)}>Accept</button>
                <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => respondOffer(o.offer_id, false)}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {offerFor && (
        <Modal onClose={() => setOfferFor(null)}>
          <h2>Offer a trade for {offerFor.name}</h2>
          <p>Pick one of your held cards to offer in exchange (1-for-1, no money).</p>
          <div className="field">
            <select value={chosenCardId} onChange={(e) => setChosenCardId(e.target.value)}>
              <option value="">Select a card…</option>
              {tradable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <button className="btn btn-primary btn-block" disabled={busy || !chosenCardId} onClick={makeOffer}>Send Offer</button>
        </Modal>
      )}
    </div>
  );
}

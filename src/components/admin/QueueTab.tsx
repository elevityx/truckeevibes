'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { safeWebsite } from '@/components/list/links';
import {
  adminCardOpen,
  adminDecideCard,
  adminOwnerMinutes7d,
  adminQueue,
  toDataError,
  userMessage,
  type CardDecision,
  type CardKind,
  type QueueCard,
} from '@/lib/data';
import { formatRange } from '@/lib/time/pacific';
import { ago, minutes, nowMs } from './format';
import HeldRunCard from './HeldRunCard';
import { createRequestGate, gated } from './requestGate';
import { canDecide, initialQueueState, openCount, queueReducer, reviewSeconds } from './queueState';

const TZ = 'America/Los_Angeles';

const KIND_LABEL: Record<CardKind, string> = {
  event: 'New event',
  possible_duplicate: 'Possible duplicate',
  held_run: 'Held run',
  source_budget: 'Source limit',
};

/** The buttons each kind offers, in order. The first is the main action. */
const ACTIONS: Record<CardKind, { decision: CardDecision; label: string; danger?: boolean }[]> = {
  event: [{ decision: 'approve', label: 'Approve' }, { decision: 'reject', label: 'Reject', danger: true }],
  possible_duplicate: [{ decision: 'merge', label: 'Merge' }, { decision: 'distinct', label: 'Distinct' }],
  held_run: [{ decision: 'accept', label: 'Accept' }, { decision: 'discard', label: 'Discard', danger: true }],
  source_budget: [{ decision: 'ack', label: 'Got it' }],
};

interface CardProps {
  card: QueueCard;
  open: boolean;
  busy: boolean;
  error: string;
  now: number;
  onToggle(): void;
  onDecide(decision: CardDecision, reason: string): void;
}

function Card({ card, open, busy, error, now, onToggle, onDecide }: CardProps) {
  const [reason, setReason] = useState('');
  const ev = card.event;
  const title = ev?.title ?? (card.kind === 'held_run' ? 'Held ingest run' : 'Source reached its card limit');
  const when = ev ? formatRange(ev.startsAt, ev.endsAt, TZ) : `opened ${ago(card.createdAt, now)}`;
  return (
    <li className="qcard">
      <button type="button" className="qhead" aria-expanded={open} onClick={onToggle}>
        <span className="pill">{KIND_LABEL[card.kind]}</span>
        <span className="qt">
          <strong>{title}</strong>
          <span className="src-meta">{when}</span>
        </span>
      </button>
      {open && (
        <div className="qbody">
          {ev && (
            <div className="qev">
              <p className="qline">
                {[ev.venue, ev.address ?? ev.town].filter(Boolean).join(', ') || 'No place listed'}
                {ev.area ? ` · ${ev.area}` : ''}
              </p>
              {ev.summary && <p>{ev.summary}</p>}
              <p className="src-meta">
                {ev.categories.join(', ') || 'no category'} · {ev.priceKind} · {ev.age}
                {ev.confidence !== null ? ` · confidence ${ev.confidence}` : ''}
                {ev.lockedFields.length > 0 ? ` · locked: ${ev.lockedFields.join(', ')}` : ''}
              </p>
              {[ev.organizerUrl, ev.ticketUrl].map((u, i) => {
                const href = safeWebsite(u);
                return href ? (
                  <p key={i} className="src-meta">
                    <a href={href} target="_blank" rel="nofollow ugc noopener noreferrer">{i === 0 ? 'Organizer page' : 'Tickets'}</a>
                  </p>
                ) : null;
              })}
            </div>
          )}
          {card.sources.length > 0 && (
            <div>
              <h4>Seen at</h4>
              <ul className="plain">
                {card.sources.map((s, i) => {
                  const href = safeWebsite(s.sourceUrl);
                  return (
                    <li key={i}>
                      {href ? <a href={href} target="_blank" rel="nofollow ugc noopener noreferrer">{s.name}</a> : s.name}{' '}
                      <span className="src-meta">{s.class} · {s.trust}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {card.otherEvent && (
            <div>
              <h4>Possibly the same as</h4>
              <p>{card.otherEvent.title}</p>
              <p className="src-meta">{formatRange(card.otherEvent.startsAt, null, TZ)} · {card.otherEvent.status}</p>
            </div>
          )}
          {card.duplicates.length > 0 && (
            <div>
              <h4>Same day</h4>
              <ul className="plain">
                {card.duplicates.map((d) => (
                  <li key={d.id}>{d.title} <span className="src-meta">{formatRange(d.startsAt, null, TZ)} · {d.status}</span></li>
                ))}
              </ul>
            </div>
          )}
          {card.heldRun && <HeldRunCard run={card.heldRun} />}
          {card.kind === 'source_budget' && <p>This source produced more cards than its weekly limit, so it stays listed as link-only until you review it.</p>}
          <label className="lbl">
            Reason (optional)
            <input className="field" type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && <p className="err" role="alert">{error}</p>}
          <div className="row">
            {ACTIONS[card.kind].map((a, i) => (
              <button
                key={a.decision}
                type="button"
                className={`btn ${i === 0 ? 'primary' : 'ghost'}`}
                disabled={busy}
                onClick={() => onDecide(a.decision, reason.trim())}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

/** The review queue: soonest event first. Opening a card starts its timer; deciding sends the seconds spent. */
export default function QueueTab({ onForbidden, onCount }: { onForbidden(): void; onCount(n: number): void }) {
  const [state, dispatch] = useReducer(queueReducer, initialQueueState);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [now, setNow] = useState(() => nowMs());
  const [ownerMinutes, setOwnerMinutes] = useState<number | null>(null);
  const queueGate = useRef(createRequestGate());
  const minutesGate = useRef(createRequestGate());
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const load = useCallback(async () => {
    try {
      const r = await gated(queueGate.current, () => adminQueue(null, 100), (cards) => dispatch({ type: 'loaded', cards }));
      if (r === 'applied') setErr('');
    } catch (e) {
      const d = toDataError(e);
      if (d.code === 'forbidden') return onForbidden();
      setErr(userMessage(d));
    } finally {
      setLoading(false);
      setNow(nowMs());
    }
  }, [onForbidden]);

  // Weekly owner time from the database (the same figure as the weekly report). A failure leaves the dash and does not block the queue.
  const loadMinutes = useCallback(async () => {
    try {
      await gated(minutesGate.current, () => adminOwnerMinutes7d(), (m) => setOwnerMinutes(m));
    } catch (e) {
      if (toDataError(e).code === 'forbidden') onForbidden();
      else setOwnerMinutes(null);
    }
  }, [onForbidden]);

  useEffect(() => {
    const t = setTimeout(() => {
      void load();
      void loadMinutes();
    }, 0);
    return () => clearTimeout(t);
  }, [load, loadMinutes]);

  useEffect(() => onCount(openCount(state)), [state, onCount]);

  const toggle = (id: string) => {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    if (stateRef.current.openedAt[id] === undefined) {
      dispatch({ type: 'opened', id, at: nowMs() });
      adminCardOpen(id).catch((e) => {
        if (toDataError(e).code === 'forbidden') onForbidden();
      });
    }
  };

  const decide = async (id: string, decision: CardDecision, reason: string) => {
    const s = stateRef.current;
    if (!canDecide(s, id)) return;
    const secs = reviewSeconds(s.openedAt[id], nowMs());
    // A refresh that began before this decision must not re-add the card: the local removal is authoritative.
    queueGate.current.invalidate();
    dispatch({ type: 'decide_start', id });
    try {
      await adminDecideCard(id, decision, reason || null, secs);
      dispatch({ type: 'decided', id });
      setSessionSeconds((t) => t + secs);
      setExpanded((cur) => (cur === id ? null : cur));
    } catch (e) {
      const d = toDataError(e);
      if (d.code === 'forbidden') onForbidden();
      dispatch({ type: 'decide_failed', id, code: d.code });
    } finally {
      void loadMinutes();
    }
  };

  const n = openCount(state);
  return (
    <div className="panel">
      <div className="qtop">
        <h3>
          Review queue <span className="pill">{n} open</span>
        </h3>
        <span>Owner time, last 7 days: {ownerMinutes === null ? '—' : `${minutes(ownerMinutes * 60)} min`}</span>
        <span className="src-meta">This session: {minutes(sessionSeconds)} min</span>
        <span className="sp" />
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            setLoading(true);
            void load();
            void loadMinutes();
          }}
          disabled={loading || Object.keys(state.busy).length > 0}
        >
          Refresh
        </button>
      </div>
      {err && <p className="err" role="alert">{err}</p>}
      {loading && n === 0 ? (
        <p className="fine">Loading…</p>
      ) : n === 0 ? (
        <p className="card">Nothing waiting. The queue is empty.</p>
      ) : (
        <ul className="qlist">
          {state.cards.map((c) => (
            <Card
              key={c.id}
              card={c}
              open={expanded === c.id}
              busy={!!state.busy[c.id]}
              error={state.errors[c.id] ? userMessage(toDataError({ message: state.errors[c.id] })) : ''}
              now={now}
              onToggle={() => toggle(c.id)}
              onDecide={(d, r) => void decide(c.id, d, r)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

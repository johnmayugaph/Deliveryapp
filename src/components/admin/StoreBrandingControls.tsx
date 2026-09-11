'use client';

import { useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  removeStoreImageAction,
  uploadStoreImageAction,
} from '@/lib/actions/admin-actions';
import type { AdminActionResult } from '@/lib/admin/access';
import { MIN_AUDIT_REASON_LENGTH } from '@/lib/admin/audit-reason';
import { BANNER_EDGES, downscalePhoto } from '@/lib/media/downscale';

type Kind = 'LOGO' | 'BANNER';

/**
 * Putting a picture on a shop, from a file on the operator's computer.
 *
 * THE THING THAT WAS MISSING. The panel this replaces asked for a web
 * ADDRESS, which silently assumed the picture was already hosted somewhere.
 * What an operator actually has is a JPEG the shop sent them over Viber, and
 * there was nowhere to put it — so shops onboarded through the console had no
 * logo, and the storefront's tinted-initial fallback was doing all the work.
 *
 * ONE REASON BOX FOR BOTH PICTURES, and it is above them. Every console action
 * is explained by a person, and that rule has no exception here; what it has
 * is an ORDER. The buttons stay disabled until the reason is written, so the
 * file picker never opens on a form that is going to refuse the file — which
 * is the one way a required reason could cost somebody their upload.
 *
 * The file is resized in the browser before it is sent, because a photo off a
 * phone is several megabytes and a server action's body limit is one. The
 * bytes are validated again on the server; this runs on a machine somebody
 * else controls.
 */
export function StoreBrandingControls({
  storeId,
  storeName,
  logoUrl,
  coverUrl,
}: {
  storeId: string;
  storeName: string;
  logoUrl: string | null;
  coverUrl: string | null;
}) {
  const router = useRouter();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<(AdminActionResult & { kind: Kind }) | null>(null);
  const [busyKind, setBusyKind] = useState<Kind | null>(null);
  const [stage, setStage] = useState<'IDLE' | 'RESIZING' | 'SENDING'>('IDLE');

  const reasonGiven = reason.trim().length >= MIN_AUDIT_REASON_LENGTH;

  function run(kind: Kind, image?: File): void {
    startTransition(async () => {
      const formData = new FormData();
      formData.set('storeId', storeId);
      formData.set('kind', kind);
      formData.set('reason', reason);
      if (image) formData.set('image', image);

      setStage('SENDING');
      const result = image
        ? await uploadStoreImageAction(null, formData)
        : await removeStoreImageAction(null, formData);
      setStage('IDLE');
      setBusyKind(null);
      setNote({ ...result, kind });
      if (result.ok) router.refresh();
    });
  }

  async function onPicked(kind: Kind, file: File): Promise<void> {
    setNote(null);
    setBusyKind(kind);
    setStage('RESIZING');
    try {
      // A banner is the full width of the page and a logo is a thumbnail, so
      // they are not resized to the same size.
      const resized = await downscalePhoto(file, kind === 'BANNER' ? BANNER_EDGES : undefined);
      run(kind, resized);
    } catch (error) {
      setStage('IDLE');
      setBusyKind(null);
      setNote({
        ok: false,
        kind,
        message: error instanceof Error ? error.message : 'That image could not be used.',
      });
    }
  }

  const busy = pending || stage !== 'IDLE';

  return (
    <div className="space-y-4">
      <label className="block" htmlFor={reasonId}>
        <span className="block text-[11px] font-bold text-ink-muted">
          Why (recorded against your name)
        </span>
        <input
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Shop sent their new logo"
          className="mt-0.5 w-full max-w-md rounded-lg bg-surface-sunken px-3 py-2 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>

      <div className="flex flex-wrap items-start gap-6">
        <Slot
          kind="LOGO"
          storeName={storeName}
          currentUrl={logoUrl}
          disabled={!reasonGiven || busy}
          stage={busyKind === 'LOGO' ? stage : 'IDLE'}
          note={note?.kind === 'LOGO' ? note : null}
          onPick={(file) => void onPicked('LOGO', file)}
          onRemove={() => run('LOGO')}
        />
        <Slot
          kind="BANNER"
          storeName={storeName}
          currentUrl={coverUrl}
          disabled={!reasonGiven || busy}
          stage={busyKind === 'BANNER' ? stage : 'IDLE'}
          note={note?.kind === 'BANNER' ? note : null}
          onPick={(file) => void onPicked('BANNER', file)}
          onRemove={() => run('BANNER')}
        />
      </div>

      {!reasonGiven ? (
        <p className="text-[11px] text-ink-muted">
          Write why first — the buttons turn on once you have.
        </p>
      ) : null}
    </div>
  );
}

/** One picture: what is live now, and the two things you can do to it. */
function Slot({
  kind,
  storeName,
  currentUrl,
  disabled,
  stage,
  note,
  onPick,
  onRemove,
}: {
  kind: Kind;
  storeName: string;
  currentUrl: string | null;
  disabled: boolean;
  stage: 'IDLE' | 'RESIZING' | 'SENDING';
  note: AdminActionResult | null;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const isLogo = kind === 'LOGO';
  const label = isLogo ? 'logo' : 'banner';

  return (
    <div className={isLogo ? '' : 'min-w-0 flex-1'}>
      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">
        {isLogo ? 'Logo' : 'Banner'}
      </p>

      {/* Shown as well as edited: the case that matters is a WRONG picture,
          and you cannot fix what you cannot see. Plain `<img>` because the
          value may be an `https://` link, a `data:` URL from the seed, or one
          of our own `/store-images/` rows — three shapes, one tag. */}
      {currentUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentUrl}
          alt={`${storeName} ${label}`}
          width={isLogo ? 128 : 640}
          height={isLogo ? 128 : 240}
          className={`mt-1 h-20 rounded-xl object-cover ring-1 ring-black/5 ${
            isLogo ? 'w-20' : 'w-full max-w-sm'
          }`}
        />
      ) : (
        <p
          className={`mt-1 flex h-20 items-center justify-center rounded-xl bg-surface-sunken text-[11px] text-ink-faint ring-1 ring-black/5 ${
            isLogo ? 'w-20' : 'w-full max-w-sm'
          }`}
        >
          None yet
        </p>
      )}

      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={`${isLogo ? 'Logo' : 'Banner'} image file for ${storeName}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so picking the same file twice still fires a change.
          event.target.value = '';
          if (file) onPick(file);
        }}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => input.current?.click()}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-brand-700 disabled:bg-ink-faint"
        >
          {stage === 'RESIZING'
            ? 'Resizing…'
            : stage === 'SENDING'
              ? 'Saving…'
              : currentUrl
                ? `Replace ${label}`
                : `Upload ${label}`}
        </button>

        {currentUrl ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onRemove}
            className="rounded-lg bg-surface-sunken px-3 py-1.5 text-[12px] font-bold text-ink-muted ring-1 ring-black/5 hover:text-ink disabled:text-ink-faint"
          >
            Remove
          </button>
        ) : null}
      </div>

      {note ? (
        <p
          role={note.ok ? 'status' : 'alert'}
          className={`mt-1.5 text-[11px] ${note.ok ? 'text-emerald-800' : 'text-rose-700'}`}
        >
          {note.message}
        </p>
      ) : null}
    </div>
  );
}

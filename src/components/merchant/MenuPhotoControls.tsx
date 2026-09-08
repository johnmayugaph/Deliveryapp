'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  removeMenuItemImageAction,
  uploadMenuItemImageAction,
  type MenuActionResult,
} from '@/lib/actions/menu-actions';
import { downscalePhoto } from '@/lib/media/downscale';

/**
 * Putting a photograph on a dish, from a phone.
 *
 * The input is `accept="image/*"` with no `capture` attribute, which is the
 * choice that matters on a phone: it offers the camera AND the gallery, and a
 * shop photographing today's adobo wants the camera while a shop with a
 * folder of pictures from their old menu wants the gallery. `capture="environment"`
 * would force the first and hide the second.
 *
 * The file is resized in the browser before it is sent — a camera photo is
 * three to six megabytes and a server action's body limit is one. The bytes
 * are still validated on the server, because this component runs on a device
 * its owner controls.
 *
 * Requires JavaScript, like every other control on this screen: the resize is
 * the whole reason a plain file input would not do.
 */
export function MenuPhotoControls({
  storeId,
  itemId,
  itemName,
  hasPhoto,
}: {
  storeId: string;
  itemId: string;
  itemName: string;
  hasPhoto: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<MenuActionResult | null>(null);
  const [stage, setStage] = useState<'IDLE' | 'RESIZING' | 'SENDING'>('IDLE');

  function send(fields: Record<string, string>, photo?: File): void {
    startTransition(async () => {
      const formData = new FormData();
      formData.set('storeId', storeId);
      formData.set('itemId', itemId);
      for (const [key, value] of Object.entries(fields)) formData.set(key, value);
      if (photo) formData.set('photo', photo);

      setStage('SENDING');
      const action = photo ? uploadMenuItemImageAction : removeMenuItemImageAction;
      const result = await action(null, formData);
      setStage('IDLE');
      setNote(result);
      if (result.ok) router.refresh();
    });
  }

  async function onPicked(file: File): Promise<void> {
    setNote(null);
    setStage('RESIZING');
    try {
      const resized = await downscalePhoto(file);
      send({}, resized);
    } catch (error) {
      setStage('IDLE');
      setNote({
        ok: false,
        message: error instanceof Error ? error.message : 'That photo could not be used.',
      });
    }
  }

  const busy = pending || stage !== 'IDLE';

  return (
    <div className="mt-2">
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={`Photo for ${itemName}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so that picking the same file twice still fires a change.
          event.target.value = '';
          if (file) void onPicked(file);
        }}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="text-[11px] font-semibold text-brand-700 disabled:text-ink-faint"
        >
          {stage === 'RESIZING'
            ? 'Resizing…'
            : stage === 'SENDING'
              ? 'Saving…'
              : hasPhoto
                ? 'Replace photo'
                : 'Add a photo'}
        </button>

        {hasPhoto ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => send({})}
            className="text-[11px] font-semibold text-ink-muted disabled:text-ink-faint"
          >
            Remove photo
          </button>
        ) : null}
      </div>

      {note ? (
        <p
          role={note.ok ? 'status' : 'alert'}
          className={`mt-1 text-[11px] ${note.ok ? 'text-emerald-800' : 'text-rose-700'}`}
        >
          {note.message}
        </p>
      ) : null}
    </div>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  addOptionAction,
  addOptionGroupAction,
  editOptionAction,
  editOptionGroupAction,
  moveOptionAction,
  moveOptionGroupAction,
  removeOptionAction,
  removeOptionGroupAction,
  setOptionAvailabilityAction,
  type OptionActionResult,
} from '@/lib/actions/option-actions';
import {
  MAX_GROUP_NAME_LENGTH,
  MAX_OPTION_NAME_LENGTH,
  describeGroupRule,
} from '@/lib/merchant/option-policy';
import { formatCentavos } from '@/lib/money';

type Action = (
  previous: OptionActionResult | null,
  formData: FormData,
) => Promise<OptionActionResult>;

export interface EditorOption {
  id: string;
  name: string;
  priceDeltaCentavos: number;
  isAvailable: boolean;
  isFirst: boolean;
  isLast: boolean;
}

export interface EditorGroup {
  id: string;
  name: string;
  minChoices: number;
  maxChoices: number;
  isFirst: boolean;
  isLast: boolean;
  options: EditorOption[];
}

/**
 * Declaring what a dish asks, and what the answers cost.
 *
 * The shape follows the model: a question, then its answers, then a box to add
 * another answer — and a box at the bottom to add another question. "Choose
 * one" versus "choose any" is two number fields rather than a mode switch,
 * because that is what the data is and a shop asking for two of five sides is
 * then just another pair of numbers instead of a feature request.
 *
 * Buttons with handlers rather than posting forms, like the rest of the
 * merchant screens: it needs JavaScript, and the page says so.
 */
export function OptionEditor({
  storeId,
  itemId,
  itemName,
  basePriceCentavos,
  canEdit,
  groups,
}: {
  storeId: string;
  itemId: string;
  itemName: string;
  basePriceCentavos: number;
  canEdit: boolean;
  groups: EditorGroup[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<OptionActionResult | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingOption, setEditingOption] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const value = (key: string, fallback = ''): string => draft[key] ?? fallback;
  const set = (key: string, next: string): void =>
    setDraft((current) => ({ ...current, [key]: next }));

  function run(action: Action, fields: Record<string, string>, onDone?: () => void): void {
    startTransition(async () => {
      setNote(null);
      const formData = new FormData();
      formData.set('storeId', storeId);
      formData.set('itemId', itemId);
      for (const [key, entry] of Object.entries(fields)) formData.set(key, entry);

      const result = await action(null, formData);
      if (result.ok) {
        onDone?.();
        router.refresh();
        if (!result.message.startsWith('Moved') && !result.message.startsWith('Already')) {
          setNote(result);
        }
      } else {
        setNote(result);
      }
    });
  }

  return (
    <div className="space-y-4">
      {groups.length === 0 ? (
        <p className="rounded-xl bg-surface px-3.5 py-3 text-[12px] leading-relaxed text-ink-muted shadow-sm ring-1 ring-black/5">
          {itemName} has no choices, so a customer taps Add and it goes straight
          into their cart. Add one below if it comes in sizes, or if you sell
          extras with it.
        </p>
      ) : null}

      {groups.map((group) => (
        <section
          key={group.id}
          className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
        >
          {editingGroup === group.id ? (
            <div className="space-y-2">
              <label className="block">
                <span className="text-[11px] font-semibold text-ink-muted">Question</span>
                <input
                  value={value(`g:${group.id}:name`, group.name)}
                  maxLength={MAX_GROUP_NAME_LENGTH}
                  onChange={(event) => set(`g:${group.id}:name`, event.target.value)}
                  className="mt-0.5 w-full rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </label>
              <div className="flex gap-2">
                <label className="flex-1">
                  <span className="text-[11px] font-semibold text-ink-muted">At least</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={value(`g:${group.id}:min`, String(group.minChoices))}
                    onChange={(event) => set(`g:${group.id}:min`, event.target.value)}
                    className="mt-0.5 w-full rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5"
                  />
                </label>
                <label className="flex-1">
                  <span className="text-[11px] font-semibold text-ink-muted">At most</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={value(`g:${group.id}:max`, String(group.maxChoices))}
                    onChange={(event) => set(`g:${group.id}:max`, event.target.value)}
                    className="mt-0.5 w-full rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5"
                  />
                </label>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(
                      editOptionGroupAction,
                      {
                        groupId: group.id,
                        name: value(`g:${group.id}:name`, group.name),
                        minChoices: value(`g:${group.id}:min`, String(group.minChoices)),
                        maxChoices: value(`g:${group.id}:max`, String(group.maxChoices)),
                      },
                      () => setEditingGroup(null),
                    )
                  }
                  className="rounded-lg bg-brand-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:bg-ink-faint"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingGroup(null)}
                  className="text-[11px] font-semibold text-ink-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[13px] font-semibold">
                {group.name}
                <span className="ml-1.5 text-[11px] font-normal text-ink-faint">
                  {describeGroupRule(group)}
                </span>
              </h2>
              {canEdit ? (
                <span className="flex shrink-0 items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setEditingGroup(group.id)}
                    className="text-[11px] font-semibold text-brand-700"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={pending || group.isFirst}
                    aria-label={`Move ${group.name} up`}
                    onClick={() => run(moveOptionGroupAction, { groupId: group.id, direction: 'UP' })}
                    className="text-[11px] font-semibold text-ink-muted disabled:text-ink-faint/40"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={pending || group.isLast}
                    aria-label={`Move ${group.name} down`}
                    onClick={() =>
                      run(moveOptionGroupAction, { groupId: group.id, direction: 'DOWN' })
                    }
                    className="text-[11px] font-semibold text-ink-muted disabled:text-ink-faint/40"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(removeOptionGroupAction, { groupId: group.id })}
                    className="text-[11px] font-semibold text-rose-700"
                  >
                    Remove
                  </button>
                </span>
              ) : null}
            </div>
          )}

          <ul className="mt-2 divide-y divide-black/5">
            {group.options.map((option) => (
              <li key={option.id} className="py-2">
                {editingOption === option.id ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="min-w-0 flex-1">
                      <span className="text-[11px] font-semibold text-ink-muted">Answer</span>
                      <input
                        value={value(`o:${option.id}:name`, option.name)}
                        maxLength={MAX_OPTION_NAME_LENGTH}
                        onChange={(event) => set(`o:${option.id}:name`, event.target.value)}
                        className="mt-0.5 w-full rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[13px] ring-1 ring-black/5"
                      />
                    </label>
                    <label className="w-24">
                      <span className="text-[11px] font-semibold text-ink-muted">Adds</span>
                      <span className="mt-0.5 flex items-center gap-1 rounded-lg bg-surface-sunken px-2.5 py-1.5 ring-1 ring-black/5">
                        <span className="text-[13px] text-ink-faint">+₱</span>
                        <input
                          inputMode="decimal"
                          value={value(
                            `o:${option.id}:delta`,
                            (option.priceDeltaCentavos / 100).toFixed(2),
                          )}
                          onChange={(event) => set(`o:${option.id}:delta`, event.target.value)}
                          className="w-full bg-transparent text-right text-[13px] tabular-nums focus:outline-none"
                        />
                      </span>
                    </label>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        run(
                          editOptionAction,
                          {
                            optionId: option.id,
                            name: value(`o:${option.id}:name`, option.name),
                            delta: value(
                              `o:${option.id}:delta`,
                              (option.priceDeltaCentavos / 100).toFixed(2),
                            ),
                          },
                          () => setEditingOption(null),
                        )
                      }
                      className="rounded-lg bg-brand-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:bg-ink-faint"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingOption(null)}
                      className="text-[11px] font-semibold text-ink-muted"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className={`min-w-0 flex-1 text-[13px] ${option.isAvailable ? '' : 'text-ink-faint'}`}>
                      {option.name}
                      {option.isAvailable ? '' : ' · wala ngayon'}
                    </span>
                    <span className="shrink-0 text-[12px] tabular-nums text-ink-muted">
                      {option.priceDeltaCentavos === 0
                        ? 'no extra'
                        : `+${formatCentavos(option.priceDeltaCentavos)}`}
                    </span>
                    {/* Out of stock is a shift decision, so staff get this one
                        control and none of the others. */}
                    <button
                      type="button"
                      disabled={pending}
                      aria-pressed={option.isAvailable}
                      onClick={() =>
                        run(setOptionAvailabilityAction, {
                          optionId: option.id,
                          available: option.isAvailable ? 'false' : 'true',
                        })
                      }
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        option.isAvailable
                          ? 'bg-emerald-50 text-emerald-800'
                          : 'bg-surface-sunken text-ink-faint'
                      }`}
                    >
                      {option.isAvailable ? 'In' : 'Out'}
                    </button>
                    {canEdit ? (
                      <span className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingOption(option.id)}
                          className="text-[11px] font-semibold text-brand-700"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={pending || option.isFirst}
                          aria-label={`Move ${option.name} up`}
                          onClick={() =>
                            run(moveOptionAction, { optionId: option.id, direction: 'UP' })
                          }
                          className="text-[11px] font-semibold text-ink-muted disabled:text-ink-faint/40"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={pending || option.isLast}
                          aria-label={`Move ${option.name} down`}
                          onClick={() =>
                            run(moveOptionAction, { optionId: option.id, direction: 'DOWN' })
                          }
                          className="text-[11px] font-semibold text-ink-muted disabled:text-ink-faint/40"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(removeOptionAction, { optionId: option.id })}
                          className="text-[11px] font-semibold text-rose-700"
                        >
                          ×<span className="sr-only"> remove {option.name}</span>
                        </button>
                      </span>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {canEdit ? (
            <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-black/5 pt-2">
              <label className="min-w-0 flex-1">
                <span className="text-[11px] font-semibold text-ink-muted">Add an answer</span>
                <input
                  value={value(`new:${group.id}:name`)}
                  placeholder="Large"
                  maxLength={MAX_OPTION_NAME_LENGTH}
                  onChange={(event) => set(`new:${group.id}:name`, event.target.value)}
                  className="mt-0.5 w-full rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[13px] ring-1 ring-black/5"
                />
              </label>
              <label className="w-24">
                <span className="text-[11px] font-semibold text-ink-muted">Adds</span>
                <span className="mt-0.5 flex items-center gap-1 rounded-lg bg-surface-sunken px-2.5 py-1.5 ring-1 ring-black/5">
                  <span className="text-[13px] text-ink-faint">+₱</span>
                  <input
                    inputMode="decimal"
                    value={value(`new:${group.id}:delta`)}
                    placeholder="0"
                    onChange={(event) => set(`new:${group.id}:delta`, event.target.value)}
                    className="w-full bg-transparent text-right text-[13px] tabular-nums focus:outline-none"
                  />
                </span>
              </label>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    addOptionAction,
                    {
                      groupId: group.id,
                      name: value(`new:${group.id}:name`),
                      delta: value(`new:${group.id}:delta`),
                    },
                    () =>
                      setDraft((current) => ({
                        ...current,
                        [`new:${group.id}:name`]: '',
                        [`new:${group.id}:delta`]: '',
                      })),
                  )
                }
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:bg-ink-faint"
              >
                Add
              </button>
            </div>
          ) : null}
        </section>
      ))}

      {canEdit ? (
        <section className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="text-[13px] font-semibold">Add a choice</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
            “Size” asking for one answer, or “Add-ons” asking for none and
            allowing several. A choice that asks for at least one cannot be
            skipped by a customer.
          </p>
          <div className="mt-2 space-y-2">
            <label className="block">
              <span className="text-[11px] font-semibold text-ink-muted">Question</span>
              <input
                value={value('new:group:name')}
                placeholder="Size"
                maxLength={MAX_GROUP_NAME_LENGTH}
                onChange={(event) => set('new:group:name', event.target.value)}
                className="mt-0.5 w-full rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[13px] ring-1 ring-black/5"
              />
            </label>
            <div className="flex gap-2">
              <label className="flex-1">
                <span className="text-[11px] font-semibold text-ink-muted">At least</span>
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={value('new:group:min', '1')}
                  onChange={(event) => set('new:group:min', event.target.value)}
                  className="mt-0.5 w-full rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5"
                />
              </label>
              <label className="flex-1">
                <span className="text-[11px] font-semibold text-ink-muted">At most</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={value('new:group:max', '1')}
                  onChange={(event) => set('new:group:max', event.target.value)}
                  className="mt-0.5 w-full rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5"
                />
              </label>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  addOptionGroupAction,
                  {
                    name: value('new:group:name'),
                    minChoices: value('new:group:min', '1'),
                    maxChoices: value('new:group:max', '1'),
                  },
                  () => setDraft((current) => ({ ...current, 'new:group:name': '' })),
                )
              }
              className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-[13px] font-semibold text-white disabled:bg-ink-faint"
            >
              Add the choice
            </button>
            <noscript>
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                Editing choices needs JavaScript. Turn it on, or use another
                browser.
              </p>
            </noscript>
          </div>
        </section>
      ) : null}

      {note ? (
        <p
          role={note.ok ? 'status' : 'alert'}
          className={`text-[12px] ${note.ok ? 'text-emerald-800' : 'text-rose-700'}`}
        >
          {note.message}
        </p>
      ) : null}

      <p className="text-[11px] leading-relaxed text-ink-faint">
        A customer sees {formatCentavos(basePriceCentavos)} plus whatever they
        choose. Every price is recalculated from these rows when they check out,
        so nothing they do in their own browser can change what they are
        charged.
      </p>
    </div>
  );
}

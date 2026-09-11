import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStoreImageHref, storeImageHref } from '@/lib/media/image-bytes';
import {
  orphanImageIds,
  parseStoreImageKind,
  StoreImageKindUnknownError,
  STORE_IMAGE_LABEL,
} from '@/lib/media/store-images';

/**
 * Uploading a shop's logo and banner.
 *
 * The panel before this one took a web ADDRESS, which assumed the picture was
 * already hosted somewhere — so an operator holding a JPEG the shop had sent
 * them could not add it at all. These tests cover the two rules that are easy
 * to get quietly wrong once BOTH doors write the same two columns: which
 * uploads are ours to delete, and what `kind` a form is allowed to claim.
 *
 * The bytes themselves are not re-tested here — `readImageFacts` is shared
 * with menu photographs and `menu-photos.test.ts` already covers it in full.
 */

function codeOnly(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

describe('which picture a form is asking about', () => {
  it('takes the two kinds that exist', () => {
    expect(parseStoreImageKind('LOGO')).toBe('LOGO');
    expect(parseStoreImageKind('BANNER')).toBe('BANNER');
  });

  it('refuses anything else rather than defaulting to one', () => {
    // A default here would put a banner in the logo slot on a typo, and the
    // wrong picture on a customer's screen is the whole failure mode.
    for (const value of ['logo', 'COVER', '', null, undefined, 42]) {
      expect(() => parseStoreImageKind(value), String(value)).toThrow(
        StoreImageKindUnknownError,
      );
    }
  });

  it('has a word for each kind that an operator would use', () => {
    expect(STORE_IMAGE_LABEL.LOGO).toBe('logo');
    expect(STORE_IMAGE_LABEL.BANNER).toBe('banner');
  });
});

describe('telling our own uploads from a link somebody pasted', () => {
  it('recognises an address this application served', () => {
    expect(isStoreImageHref(storeImageHref('img_1'))).toBe(true);
  });

  it('does not claim a hosted link or a pasted data image', () => {
    expect(isStoreImageHref('https://cdn.example.com/logo.png')).toBe(false);
    expect(isStoreImageHref('data:image/png;base64,AAAA')).toBe(false);
    expect(isStoreImageHref('/menu-images/img_1')).toBe(false);
    expect(isStoreImageHref(null)).toBe(false);
  });
});

describe('stored pictures nothing points at any more', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];

  it('keeps both while both columns point at them', () => {
    expect(
      orphanImageIds(rows, {
        logoUrl: storeImageHref('a'),
        coverUrl: storeImageHref('b'),
      }),
    ).toEqual([]);
  });

  it('collects the one whose column was overwritten with a hosted link', () => {
    expect(
      orphanImageIds(rows, {
        logoUrl: 'https://cdn.example.com/logo.png',
        coverUrl: storeImageHref('b'),
      }),
    ).toEqual(['a']);
  });

  it('collects both when both columns were cleared', () => {
    expect(orphanImageIds(rows, { logoUrl: null, coverUrl: null })).toEqual(['a', 'b']);
  });

  /*
   * The reason this compares against BOTH columns rather than against the one
   * whose kind matches. Moving a picture from the banner slot to the logo slot
   * leaves the row's `kind` saying BANNER while `logoUrl` is what points at
   * it — a per-kind check would delete bytes that are on a customer's screen.
   */
  it('keeps a picture that has moved to the other slot', () => {
    expect(orphanImageIds([{ id: 'a' }], { logoUrl: null, coverUrl: storeImageHref('a') })).toEqual(
      [],
    );
  });
});

describe('the two doors onto the same two columns', () => {
  /*
   * The address form can overwrite a column that held `/store-images/<id>`.
   * If it does that without pruning, those bytes stay in the database
   * reachable from no page at all — invisible, undeletable through any screen,
   * and growing every time somebody edits a shop. Nothing else would fail, so
   * nothing else would notice.
   */
  it('has the address form delete uploads it has orphaned', () => {
    const code = codeOnly('src/lib/actions/admin-actions.ts');
    const action = code.slice(code.indexOf('export async function setStoreBrandingAction'));
    const body = action.slice(0, action.indexOf('export async function', 1));
    expect(body).toContain('pruneOrphanStoreImages');
  });

  it('has the upload refresh the storefront, not just the console', () => {
    // The picture changed for CUSTOMERS. Revalidating only the admin pages
    // would leave the old logo cached on the page that matters.
    const code = codeOnly('src/lib/actions/admin-actions.ts');
    for (const name of ['uploadStoreImageAction', 'removeStoreImageAction']) {
      const action = code.slice(code.indexOf(`export async function ${name}`));
      const body = action.slice(0, action.indexOf('export async function', 1));
      expect(body, name).toContain('revalidatePath(`/stores/${store.slug}`)');
    }
  });
});

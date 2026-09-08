import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_IMAGE_TYPES,
  IMAGE_CACHE_CONTROL,
  ImageTooLargeError,
  ImageWrongShapeError,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MIN_IMAGE_EDGE,
  NotAnImageError,
  menuImageHref,
  readImageFacts,
} from '@/lib/media/image-bytes';

/**
 * Photographs on dishes.
 *
 * Almost everything here is about ONE rule: nothing the client said about the
 * file is believed. A browser sends a MIME type and a filename, both typed by
 * whoever is uploading, so the type comes from the magic bytes and the size
 * from the header — and these tests are mostly hand-built headers checking
 * that the reader gets them right and refuses what it does not recognise.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function codeOnly(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

/** A real PNG header: signature, then an IHDR chunk carrying the size. */
function png(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(24 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * A JPEG with `segments` bytes of preamble before the frame.
 *
 * The preamble is what makes this worth testing: a phone photo carries EXIF,
 * an ICC profile and often an embedded thumbnail before the start-of-frame, so
 * the size is never at a fixed offset and the reader has to walk to it.
 */
function jpeg(
  width: number,
  height: number,
  options: { preamble?: number; marker?: number; padding?: boolean } = {},
): Uint8Array {
  const preamble = options.preamble ?? 0;
  const marker = options.marker ?? 0xc0;
  const head: number[] = [0xff, 0xd8, 0xff];
  // A preamble segment: marker, then its own length, then filler.
  if (preamble > 0) {
    head.push(0xe1, ((preamble + 2) >> 8) & 0xff, (preamble + 2) & 0xff);
    for (let index = 0; index < preamble; index += 1) head.push(0x00);
  } else {
    // Nothing before the frame: the 0xFF from the signature is the frame's.
    head.pop();
  }
  if (options.padding) head.push(0xff, 0xff);
  head.push(0xff, marker, 0x00, 0x11, 0x08);
  head.push((height >> 8) & 0xff, height & 0xff);
  head.push((width >> 8) & 0xff, width & 0xff);
  // Enough trailing bytes that the reader is never parsing off the end.
  for (let index = 0; index < 32; index += 1) head.push(0x00);
  return new Uint8Array(head);
}

describe('reading what a file actually is', () => {
  it('reads a PNG’s size from its IHDR', () => {
    const facts = readImageFacts(png(800, 600));
    expect(facts).toMatchObject({ contentType: 'image/png', width: 800, height: 600 });
  });

  it('reads a JPEG’s size after walking past its EXIF', () => {
    const facts = readImageFacts(jpeg(800, 600, { preamble: 400 }));
    expect(facts).toMatchObject({ contentType: 'image/jpeg', width: 800, height: 600 });
  });

  it('reads a JPEG with no preamble at all', () => {
    expect(readImageFacts(jpeg(640, 480))).toMatchObject({ width: 640, height: 480 });
  });

  it('walks past the 0xFF padding a segment may be followed by', () => {
    const facts = readImageFacts(jpeg(700, 700, { preamble: 20, padding: true }));
    expect(facts.width).toBe(700);
  });

  it('accepts every start-of-frame a real encoder emits', () => {
    // Baseline (C0), progressive (C2) and the arithmetic variants all carry
    // the size in the same place. C4, C8 and CC are not frames at all.
    for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc9, 0xcd]) {
      const facts = readImageFacts(jpeg(500, 400, { preamble: 8, marker }));
      expect(facts.width, marker.toString(16)).toBe(500);
    }
  });

  it('reports the byte size from the array, not from anything claimed', () => {
    expect(readImageFacts(png(400, 400, 5_000)).byteSize).toBe(24 + 5_000);
  });

  it('refuses a file that is not an image at all', () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([0x00]),
      // A PDF, a ZIP (which is what a .docx is), and an ELF binary.
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
      new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]),
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    ]) {
      expect(() => readImageFacts(bytes)).toThrow(NotAnImageError);
    }
  });

  it('refuses an SVG, which is a document that can carry script', () => {
    // Named separately because it is the one "image" that is really markup:
    // served from our own origin it would be a stored cross-site script.
    const svg = new TextEncoder().encode(
      '<svg onload="alert(1)" xmlns="http://www.w3.org/2000/svg"/>',
    );
    expect(() => readImageFacts(svg)).toThrow(NotAnImageError);
    expect(ALLOWED_IMAGE_TYPES).not.toContain('image/svg+xml');
  });

  it('refuses a JPEG signature with nothing behind it', () => {
    // A truncated upload, or somebody probing with three bytes.
    expect(() => readImageFacts(new Uint8Array([0xff, 0xd8, 0xff]))).toThrow(NotAnImageError);
  });

  it('refuses a PNG signature whose first chunk is not IHDR', () => {
    const bytes = png(100, 100);
    bytes.set([0x66, 0x41, 0x6b, 0x45], 12);
    expect(() => readImageFacts(bytes)).toThrow(NotAnImageError);
  });
});

describe('the limits', () => {
  it('refuses a photo over the size limit', () => {
    expect(() => readImageFacts(png(800, 600, MAX_IMAGE_BYTES))).toThrow(ImageTooLargeError);
  });

  it('names the size in the refusal, so it can be acted on', () => {
    try {
      readImageFacts(png(800, 600, MAX_IMAGE_BYTES));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/KB/);
    }
  });

  it('refuses a picture too small to be worth showing', () => {
    expect(() => readImageFacts(png(MIN_IMAGE_EDGE - 1, 400))).toThrow(ImageWrongShapeError);
    expect(() => readImageFacts(png(400, MIN_IMAGE_EDGE - 1))).toThrow(ImageWrongShapeError);
  });

  it('refuses one that was never resized', () => {
    // Not a rule about taste: a 4000px photo means the upload path did not do
    // its job, and storing it would be a megabyte per dish.
    expect(() => readImageFacts(png(MAX_IMAGE_EDGE + 1, 400))).toThrow(ImageWrongShapeError);
  });

  it('accepts the edges of the range', () => {
    expect(readImageFacts(png(MIN_IMAGE_EDGE, MIN_IMAGE_EDGE)).width).toBe(MIN_IMAGE_EDGE);
    expect(readImageFacts(png(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE)).width).toBe(MAX_IMAGE_EDGE);
  });

  it('refuses a zero-sized image rather than dividing by it', () => {
    expect(() => readImageFacts(png(0, 0))).toThrow(ImageWrongShapeError);
  });

  it('keeps the browser’s target well inside the server’s limit', () => {
    // The browser resizes to 800px and the server accepts up to 2000px, so a
    // photo that was resized can never be refused for its shape.
    const downscale = source('src/lib/media/downscale.ts');
    const target = Number(/const TARGET_EDGE = ([\d_]+)/.exec(downscale)?.[1]?.replace(/_/g, ''));
    expect(target).toBeGreaterThan(MIN_IMAGE_EDGE);
    expect(target).toBeLessThan(MAX_IMAGE_EDGE);
  });
});

describe('where a photo is served from', () => {
  it('builds one URL, in one place', () => {
    expect(menuImageHref('cm123')).toBe('/menu-images/cm123');
  });

  it('is cached forever, which is safe because ids are never reused', () => {
    expect(IMAGE_CACHE_CONTROL).toMatch(/immutable/);
    // A replaced photo is a new row: the store deletes and re-creates rather
    // than upserting, precisely so the URL changes.
    const store = codeOnly('src/lib/media/menu-images.ts');
    expect(store).toMatch(/deleteMany\(\{ where: \{ menuItemId/);
    expect(store).not.toMatch(/menuItemImage\.upsert/);
  });

  it('serves the type it decided, and forbids sniffing', () => {
    const route = codeOnly('src/app/menu-images/[imageId]/route.ts');
    expect(route).toMatch(/'Content-Type': image\.contentType/);
    expect(route).toMatch(/nosniff/);
  });

  it('answers a missing photo with an empty 404, not a page', () => {
    const route = codeOnly('src/app/menu-images/[imageId]/route.ts');
    expect(route).toMatch(/new NextResponse\(null, \{ status: 404 \}\)/);
  });
});

describe('the bytes stay out of the page queries', () => {
  it('never selects the whole image row', () => {
    // Prisma selects every scalar by default, so `include: { image: true }`
    // reads every photograph on a menu out of the database to render a list
    // that shows them at 48 pixels.
    for (const file of [
      'src/lib/merchant/menu.ts',
      'src/app/stores/[slug]/page.tsx',
      'src/lib/search/global-search.ts',
    ]) {
      expect(codeOnly(file), file).not.toMatch(/image:\s*true/);
      expect(codeOnly(file), file).toMatch(/image:\s*\{\s*select/);
    }
  });

  it('reads the bytes in exactly one place', () => {
    const store = source('src/lib/media/menu-images.ts');
    expect(store).toMatch(/readMenuItemImage/);
    // Only the route handler calls it.
    const callers = ['src/app/menu-images/[imageId]/route.ts'];
    for (const caller of callers) {
      expect(source(caller)).toMatch(/readMenuItemImage\(/);
    }
  });
});

describe('who may put a photo on a dish', () => {
  const actions = codeOnly('src/lib/actions/menu-actions.ts');

  it('needs a manager, like every other change to the menu', () => {
    for (const name of ['uploadMenuItemImageAction', 'removeMenuItemImageAction']) {
      const start = actions.indexOf(`export async function ${name}`);
      expect(start, name).toBeGreaterThan(-1);
      const next = actions.indexOf('export async function', start + 1);
      const body = actions.slice(start, next === -1 ? undefined : next);
      expect(body, name).toContain('requireStoreAccess(');
      expect(body, name).toContain('StoreRole.MANAGER');
    }
  });

  it('scopes the upload to the store, so a neighbour’s dish cannot be touched', () => {
    const store = codeOnly('src/lib/media/menu-images.ts');
    expect(store).toMatch(/findFirst\(\{[\s\S]*?storeId: input\.storeId/);
    expect(store).toMatch(/MenuItemNotInStoreError/);
  });

  it('validates the bytes rather than the form field', () => {
    const store = codeOnly('src/lib/media/menu-images.ts');
    expect(store).toMatch(/readImageFacts\(input\.bytes\)/);
    // The declared type is never written to the column.
    expect(store).not.toMatch(/file\.type/);
    expect(store).toMatch(/contentType: facts\.contentType/);
  });
});

describe('the screens', () => {
  it('renders nothing where a dish has no photo', () => {
    // A column of grey placeholders makes a text-only menu look broken; most
    // menus start with no photographs at all.
    for (const file of [
      'src/components/merchant/MenuRow.tsx',
      'src/app/stores/[slug]/page.tsx',
    ]) {
      expect(source(file), file).toMatch(/\?\s*\(\s*(\/\/[^\n]*\n\s*)?<img/);
    }
  });

  it('offers the camera and the gallery, not one of them', () => {
    // `capture="environment"` would force the camera and hide a shop's
    // existing folder of photographs.
    // `codeOnly`, because the component's own docstring explains why
    // `capture` is absent — and a plain grep would find the explanation and
    // report the file as breaking the rule it documents.
    const picker = codeOnly('src/components/merchant/MenuPhotoControls.tsx');
    expect(picker).toMatch(/accept="image\/\*"/);
    expect(picker).not.toMatch(/capture=/);
  });

  it('resizes before sending, because a camera photo is bigger than the limit', () => {
    const picker = codeOnly('src/components/merchant/MenuPhotoControls.tsx');
    expect(picker).toMatch(/downscalePhoto\(/);
  });

  it('says how big the saved photo was', () => {
    // The one number that tells a shop whether the upload did what it should.
    expect(source('src/lib/actions/menu-actions.ts')).toMatch(/KB\./);
  });
});

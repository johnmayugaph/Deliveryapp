/**
 * What is actually in those bytes.
 *
 * Everything here is pure and works on a `Uint8Array`, because the one rule
 * that matters for an upload is that **nothing the client said about the file
 * is believed**. A browser sends a MIME type and a filename; both are typed by
 * whoever is uploading, and `image/jpeg` on a 4MB executable is a sentence
 * anybody can write. So the type comes from the magic bytes, the dimensions
 * come from the header, and the size comes from the array itself.
 *
 * No image library. Reading a JPEG's SOF segment and a PNG's IHDR is thirty
 * lines, and the alternative is a dependency in the request path that decodes
 * attacker-supplied files — which is the exact shape of every image-library
 * CVE. Nothing here decodes pixels; it reads two numbers out of a header and
 * refuses anything it does not recognise.
 */

/** What a shop may upload. Both are re-encoded to JPEG in the browser first;
 *  PNG is accepted so that an upload made any other way still works. */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/**
 * 400 KB, after the browser has already resized the photo.
 *
 * Generous for a 1200px JPEG (they land around 150 KB) and small enough that a
 * three-hundred-item menu is 120 MB of database rather than a gigabyte. Also
 * comfortably inside the 1 MB body limit a server action has.
 */
export const MAX_IMAGE_BYTES = 400 * 1024;

/** A photo bigger than this was not resized, which means something is wrong
 *  with the upload path rather than with the picture. */
export const MAX_IMAGE_EDGE = 2_000;

/**
 * Below this a photo is worse than no photo — it renders as a smudge next to
 * the dish name. Low enough to accept a genuinely small picture somebody
 * already has, high enough to reject a favicon by mistake.
 */
export const MIN_IMAGE_EDGE = 120;

export class NotAnImageError extends Error {
  constructor() {
    super('That file is not a JPEG or a PNG. Take a photo, or pick one from your gallery.');
    this.name = 'NotAnImageError';
  }
}

export class ImageTooLargeError extends Error {
  constructor(readonly byteSize: number) {
    super(
      `That photo is ${Math.round(byteSize / 1024)} KB. The limit is ` +
        `${Math.round(MAX_IMAGE_BYTES / 1024)} KB — it should have been made smaller ` +
        'before it was sent, so please try again.',
    );
    this.name = 'ImageTooLargeError';
  }
}

export class ImageWrongShapeError extends Error {
  constructor(readonly width: number, readonly height: number) {
    super(
      `That photo is ${width}×${height}. It needs to be at least ${MIN_IMAGE_EDGE} ` +
        `pixels on each side and no more than ${MAX_IMAGE_EDGE}.`,
    );
    this.name = 'ImageWrongShapeError';
  }
}

export interface ImageFacts {
  contentType: AllowedImageType;
  width: number;
  height: number;
  byteSize: number;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** PNG: the IHDR chunk is always first, and its two big-endian uint32s are the
 *  size. Fixed offsets, so there is nothing to walk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!startsWith(bytes, PNG_SIGNATURE) || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Bytes 12-15 are the chunk type; it must be IHDR or this is not a PNG we
  // can read the size of.
  const chunkType = String.fromCharCode(...bytes.slice(12, 16));
  if (chunkType !== 'IHDR') return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * JPEG: walk the segment markers to a start-of-frame and read its size.
 *
 * A phone photo carries EXIF, an ICC profile and often a thumbnail before the
 * frame, so the offset is not fixed and the walk is the only honest way to it.
 * Every SOF variant is accepted except the two that are not frames (DHT-style
 * markers at 0xC4/0xC8/0xCC), which is what the gaps in the range below are.
 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Not at a marker: a truncated or padded file. Skip a byte rather than
      // giving up, but never run past the end.
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Padding between segments is legal and is written as repeated 0xFF.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // length(2) precision(1) height(2) width(2)
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      };
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * What this file is, or a refusal saying which rule it broke.
 *
 * The order is deliberate: type first, because "not an image" is the answer
 * that matters and the other two would be meaningless without it; then size,
 * which is cheap; then dimensions, which need the header parsed.
 */
export function readImageFacts(bytes: Uint8Array): ImageFacts {
  const png = pngSize(bytes);
  const jpeg = png ? null : jpegSize(bytes);
  const size = png ?? jpeg;
  if (!size) throw new NotAnImageError();

  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageTooLargeError(bytes.byteLength);

  const { width, height } = size;
  const smallest = Math.min(width, height);
  const largest = Math.max(width, height);
  if (smallest < MIN_IMAGE_EDGE || largest > MAX_IMAGE_EDGE || smallest <= 0) {
    throw new ImageWrongShapeError(width, height);
  }

  return {
    contentType: png ? 'image/png' : 'image/jpeg',
    width,
    height,
    byteSize: bytes.byteLength,
  };
}

/** Where a stored photo is served from. One place, so the route and every
 *  `<img>` cannot disagree about it. */
export function menuImageHref(imageId: string): string {
  return `/menu-images/${imageId}`;
}

/** How long a browser may keep one. Immutable is safe because an id is never
 *  reused: a replaced photo is a new row with a new id, and the old URL stops
 *  being referenced by any page. */
export const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Where a shop's stored logo or banner is served from. Same shape and same
 *  reasoning as `menuImageHref` — one place, so the route and every `<img>`
 *  cannot disagree about it. */
export function storeImageHref(imageId: string): string {
  return `/store-images/${imageId}`;
}

/** Whether a `Store.logoUrl` / `Store.coverUrl` value points at a row we own.
 *  Those columns still accept a hosted `https://` link, so "is this ours"
 *  decides whether removing the image also means deleting bytes. */
export function isStoreImageHref(value: string | null): boolean {
  return value !== null && STORE_IMAGE_PATH.test(value);
}

/**
 * The exact shape this application serves a shop picture at.
 *
 * Strict — one path segment of cuid characters — because it is also what the
 * address form is allowed to accept, and "starts with /store-images/" would
 * let `/store-images/../../anything` through that box.
 */
export const STORE_IMAGE_PATH = /^\/store-images\/[A-Za-z0-9_-]{1,64}$/;

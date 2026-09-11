import { MAX_IMAGE_BYTES } from '@/lib/media/image-bytes';

/**
 * Making a phone photograph small enough to send, in the browser.
 *
 * **Browser only** — it uses `canvas` and `createImageBitmap`, so it is
 * imported by client components and by nothing on the server.
 *
 * Why here rather than on the server: a photo straight off a phone camera is
 * three to six megabytes, and a server action's body limit is one. Uploading
 * the original would fail before any code of ours ran, and raising the limit
 * would mean paying for a 6 MB upload on a mobile connection to store a
 * picture that renders at 96 pixels. Resizing first is the difference between
 * a two-second save and a failure the shop cannot explain.
 *
 * It is a CONVENIENCE, not a check. The server reads the real type and size
 * out of the bytes it receives (`readImageFacts`), because anything running in
 * a browser is something the person using it can change.
 */

/**
 * 800px on the long edge, which is a decision about mobile data rather than
 * about how the photo looks.
 *
 * It is twice the width of the phone screens this is for, so it stays sharp
 * at full width, and it lands around 70–90 KB as a JPEG. The obvious
 * alternative — storing 1200px or the original and letting an image optimizer
 * produce sizes — costs a shop's customers about 150 KB per dish on a
 * connection they pay for by the megabyte, to render a photograph that is 72
 * pixels wide on the menu. A store page with twenty dishes is the difference
 * between 1.6 MB and 3 MB on a first visit.
 */
const TARGET_EDGE = 800;
/** If the first pass is still too big, the picture is unusually detailed;
 *  fewer pixels helps more than less quality at that point. */
const FALLBACK_EDGE = 600;

/**
 * A shop's banner, which is the one picture this reasoning does not fit.
 *
 * A dish photo renders 72 pixels wide in a menu row. A banner is the full
 * width of the screen, and on the desktop layout that is 1152 CSS pixels —
 * an 800px source is visibly soft there, which is the one place a shop's own
 * picture is the largest thing on the page. It is one image per shop rather
 * than one per dish, so the extra weight is paid once.
 */
export const BANNER_EDGES = { target: 1600, fallback: 1200 } as const;
/** Tried in order until one fits. 0.72 is where JPEG artefacts stop being
 *  visible on food photography. */
const QUALITY_LADDER = [0.72, 0.6, 0.5] as const;

export class CannotReadPhotoError extends Error {
  constructor() {
    super('That file could not be opened as a photo. Try taking it again.');
    this.name = 'CannotReadPhotoError';
  }
}

export class PhotoStillTooLargeError extends Error {
  constructor() {
    super('That photo could not be made small enough. Try a different one.');
    this.name = 'PhotoStillTooLargeError';
  }
}

/**
 * Decodes the file, honouring the orientation the camera recorded.
 *
 * `createImageBitmap` with `imageOrientation: 'from-image'` is the explicit
 * way to get a portrait photo the right way up; the `<img>` fallback is for
 * browsers without it, where the same is true only because every current
 * engine applies EXIF orientation when decoding for `drawImage`.
 */
async function decode(file: Blob): Promise<{
  draw: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        draw: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Fall through: some engines reject the options bag rather than
      // ignoring it, and an old browser is not a reason to refuse a photo.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new CannotReadPhotoError());
      element.src = url;
    });
    return {
      draw: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error instanceof CannotReadPhotoError ? error : new CannotReadPhotoError();
  }
}

function scaleTo(edge: number, width: number, height: number): { w: number; h: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { w: width, h: height };
  const ratio = edge / longest;
  return { w: Math.round(width * ratio), h: Math.round(height * ratio) };
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** A JPEG under the size limit, or a refusal that says which way it failed. */
export async function downscalePhoto(
  file: Blob,
  edges: { target: number; fallback: number } = {
    target: TARGET_EDGE,
    fallback: FALLBACK_EDGE,
  },
): Promise<File> {
  const decoded = await decode(file);
  try {
    for (const edge of [edges.target, edges.fallback]) {
      const { w, h } = scaleTo(edge, decoded.width, decoded.height);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d');
      if (!context) throw new CannotReadPhotoError();
      // White underneath, because a PNG with transparency re-encoded to JPEG
      // otherwise composites onto black and the dish arrives in a dark box.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, w, h);
      context.drawImage(decoded.draw, 0, 0, w, h);

      for (const quality of QUALITY_LADDER) {
        const blob = await toBlob(canvas, quality);
        if (blob && blob.size <= MAX_IMAGE_BYTES) {
          return new File([blob], 'dish.jpg', { type: 'image/jpeg' });
        }
      }
    }
    throw new PhotoStillTooLargeError();
  } finally {
    decoded.release();
  }
}

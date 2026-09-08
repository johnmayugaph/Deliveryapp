import { NextResponse } from 'next/server';
import { readMenuItemImage } from '@/lib/media/menu-images';
import { IMAGE_CACHE_CONTROL } from '@/lib/media/image-bytes';

export const dynamic = 'force-dynamic';

/**
 * One dish's photograph.
 *
 * The only reader of the bytes, and the whole of the seam between "the photo
 * lives in Postgres" and every `<img>` in the application. Moving the files to
 * object storage later is a redirect from here.
 *
 * **Public, deliberately.** A menu photo is on a page anybody can open —
 * putting it behind a session would break the storefront that exists to be
 * browsed before signing up. What is served is a picture of food; nothing
 * about the shop, the uploader or the item id is disclosed by the response.
 *
 * **Immutable for a year**, which is safe because an id is never reused: a
 * replaced photo is a new row with a new id, so no browser can be holding a
 * stale copy of a URL that now means something else. The `ETag` is there for
 * the same reason it is anywhere — a reload that changes nothing should cost
 * 304 rather than 150 KB.
 *
 * `Content-Type` comes from the column, and the column was written from the
 * magic bytes rather than from what the upload claimed. `X-Content-Type-
 * Options: nosniff` closes the other half of that: a browser must not decide
 * for itself that this is something executable.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ imageId: string }> },
) {
  const { imageId } = await params;
  const image = await readMenuItemImage(imageId);

  if (!image) {
    // No body: a missing photo is not a page, and an error message here would
    // be text rendered by a browser expecting an image.
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(Buffer.from(image.bytes), {
    status: 200,
    headers: {
      'Content-Type': image.contentType,
      'Content-Length': String(image.bytes.byteLength),
      'Cache-Control': IMAGE_CACHE_CONTROL,
      ETag: `"${imageId}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

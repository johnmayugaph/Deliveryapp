import { NextResponse } from 'next/server';
import { readStoreImage } from '@/lib/media/store-images';
import { IMAGE_CACHE_CONTROL } from '@/lib/media/image-bytes';

export const dynamic = 'force-dynamic';

/**
 * One shop's logo or banner.
 *
 * The twin of `/menu-images/<id>`, and deliberately a copy rather than a
 * shared handler: they serve different tables, and the thirty lines they have
 * in common are cache headers whose reasoning is written out in each place
 * somebody will read it.
 *
 * **Public**, because a shop's logo is on a page anybody can open. What is
 * served is a picture of a shopfront; nothing about the shop, the uploader or
 * the store id is disclosed by the response.
 *
 * **Immutable for a year**, safe because an id is never reused: replacing a
 * logo creates a new row with a new id, so no browser can be holding a stale
 * copy of a URL that now means something else.
 *
 * `Content-Type` comes from the column, which was written from the magic bytes
 * rather than from what the upload claimed, and `nosniff` closes the other
 * half of that.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ imageId: string }> },
) {
  const { imageId } = await params;
  const image = await readStoreImage(imageId);

  if (!image) {
    // No body: a missing picture is not a page, and an error message here
    // would be text rendered by a browser expecting an image.
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

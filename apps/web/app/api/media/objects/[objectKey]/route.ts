import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { AppError, errorEnvelope } from '@comm/types';
import { verifyLocalStorageToken, writeObjectStream, readObjectStream } from '@comm/storage';

/**
 * The local-filesystem `ObjectStorage` adapter's own "signed URL" target
 * (packages/storage/src/local-fs-storage.ts) — dev-only, never reached in
 * production (the S3 adapter's presigned URLs point directly at the bucket
 * instead). Deliberately does NOT call `requireAuth`/`requireCsrf`: a signed URL is,
 * by design, usable on its own without a session — exactly like a real S3 presigned
 * URL — so authorization here is entirely the HMAC token, not the caller's cookies.
 */

function unauthorized(): NextResponse {
  return NextResponse.json(errorEnvelope(new AppError('FORBIDDEN', 'This link has expired or is invalid.')), { status: 403 });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ objectKey: string }> }) {
  const { objectKey } = await params;
  const token = req.nextUrl.searchParams.get('token');
  const payload = token ? verifyLocalStorageToken(token, objectKey, 'put') : null;
  if (!payload || !req.body) return unauthorized();

  try {
    await writeObjectStream(objectKey, req.body, payload.maxBytes);
  } catch {
    return NextResponse.json(errorEnvelope(new AppError('MEDIA_TOO_LARGE', 'File is too large.')), { status: 413 });
  }
  return new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ objectKey: string }> }) {
  const { objectKey } = await params;
  const token = req.nextUrl.searchParams.get('token');
  const payload = token ? verifyLocalStorageToken(token, objectKey, 'get') : null;
  if (!payload) return unauthorized();

  const stream = await readObjectStream(objectKey);
  if (!stream) {
    return NextResponse.json(errorEnvelope(new AppError('NOT_FOUND', 'File not found.')), { status: 404 });
  }
  // Never the real mime type — the server doesn't know it (see storage.ts's
  // docstring); the client decrypts and re-attaches the real type from the
  // E2E-delivered descriptor before presenting the file to the user.
  return new NextResponse(stream, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
}

import { NextResponse } from "next/server";

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json<ApiSuccess<T>>(
    { success: true, data },
    { status: 200, ...init }
  );
}

export function created<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json<ApiSuccess<T>>(
    { success: true, data },
    { status: 201, ...init }
  );
}

export function noContent(init?: ResponseInit): NextResponse {
  return new NextResponse(null, { status: 204, ...init });
}

export function fail(
  code: string,
  message: string,
  status = 400,
  details?: unknown,
  init?: ResponseInit
): NextResponse {
  return NextResponse.json<ApiError>(
    { success: false, error: { code, message, details } },
    { status, ...init }
  );
}

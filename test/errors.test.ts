/**
 * Error hierarchy + errorFromStatus tests.
 */
import { describe, it, expect } from 'vitest';
import {
  HuduError, HuduConfigError, HuduNetworkError, BadRequestError, UnauthorizedError,
  ForbiddenError, NotFoundError, MethodNotAllowedError, NotAcceptableError,
  UnprocessableEntityError, RateLimitError, ServerError, errorFromStatus, isHuduError,
} from '../src/errors.js';

describe('errorFromStatus', () => {
  it('maps 400 -> BadRequestError', () => {
    const e = errorFromStatus(400, { error: 'bad' }, 'https://x/api/v1/companies');
    expect(e).toBeInstanceOf(BadRequestError);
    expect(e.status).toBe(400);
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.url).toBe('https://x/api/v1/companies');
    expect(e.body).toEqual({ error: 'bad' });
  });
  it('maps 401 -> UnauthorizedError', () => {
    expect(errorFromStatus(401, null)).toBeInstanceOf(UnauthorizedError);
  });
  it('maps 403 -> ForbiddenError', () => {
    expect(errorFromStatus(403, null)).toBeInstanceOf(ForbiddenError);
  });
  it('maps 404 -> NotFoundError', () => {
    expect(errorFromStatus(404, 'nope')).toBeInstanceOf(NotFoundError);
  });
  it('maps 405 -> MethodNotAllowedError', () => {
    expect(errorFromStatus(405, null)).toBeInstanceOf(MethodNotAllowedError);
  });
  it('maps 406 -> NotAcceptableError', () => {
    expect(errorFromStatus(406, null)).toBeInstanceOf(NotAcceptableError);
  });
  it('maps 422 -> UnprocessableEntityError', () => {
    expect(errorFromStatus(422, null)).toBeInstanceOf(UnprocessableEntityError);
  });
  it('maps 429 -> RateLimitError', () => {
    expect(errorFromStatus(429, null)).toBeInstanceOf(RateLimitError);
  });
  it('maps 500 -> ServerError', () => {
    const e = errorFromStatus(500, null, 'u');
    expect(e).toBeInstanceOf(ServerError);
    expect(e.status).toBe(500);
    expect(e.code).toBe('SERVER_ERROR');
  });
  it('maps 503 -> ServerError', () => {
    expect(errorFromStatus(503, null)).toBeInstanceOf(ServerError);
  });
  it('maps unknown 4xx to generic HuduError', () => {
    const e = errorFromStatus(418, null);
    expect(e).toBeInstanceOf(HuduError);
    expect(e).not.toBeInstanceOf(BadRequestError);
    expect(e.code).toBe('HTTP_418');
  });
  it('uses a string body as the message', () => {
    const e = errorFromStatus(400, 'You sent a bad request');
    expect(e.message).toBe('You sent a bad request');
  });
  it('pulls message/error out of a JSON body into err.message (B13)', () => {
    const e = errorFromStatus(400, { error: 'malformed request' });
    expect(e.message).toBe('malformed request');
    expect(e.body).toEqual({ error: 'malformed request' });
  });
  it('prefers body.message over body.error (B13)', () => {
    const e = errorFromStatus(422, { message: 'explained', error: 'raw' });
    expect(e.message).toBe('explained');
  });
  it('falls back to the status text when a record body has no message/error (B13)', () => {
    const e = errorFromStatus(404, { other: 'x' });
    expect(e).toBeInstanceOf(NotFoundError);
  });
});

describe('HuduError subclasses', () => {
  it('RateLimitError carries retryAfter', () => {
    const e = new RateLimitError('too fast', 'u', null, 30);
    expect(e.retryAfter).toBe(30);
    expect(e.status).toBe(429);
    expect(e.code).toBe('RATE_LIMIT');
  });
  it('RateLimitError without retryAfter is undefined', () => {
    const e = new RateLimitError('too fast');
    expect(e.retryAfter).toBeUndefined();
  });
  it('HuduConfigError and HuduNetworkError have proper codes and are HuduError', () => {
    expect(new HuduConfigError('bad').code).toBe('CONFIG_ERROR');
    const ne = new HuduNetworkError('down', 'https://x');
    expect(ne.code).toBe('NETWORK_ERROR');
    expect(ne.url).toBe('https://x');
  });
  it('sets name to the class name', () => {
    expect(new NotFoundError('x').name).toBe('NotFoundError');
    expect(new HuduError('x').name).toBe('HuduError');
  });
  it('sets prototype so instanceof works after subclass', () => {
    const e = new UnauthorizedError('nope');
    expect(e instanceof HuduError).toBe(true);
  });
});

describe('isHuduError', () => {
  it('returns true for HuduError instances', () => {
    expect(isHuduError(new BadRequestError('x'))).toBe(true);
  });
  it('returns false for plain errors and non-errors', () => {
    expect(isHuduError(new Error('plain'))).toBe(false);
    expect(isHuduError('string')).toBe(false);
    expect(isHuduError(undefined)).toBe(false);
    expect(isHuduError(null)).toBe(false);
  });
});

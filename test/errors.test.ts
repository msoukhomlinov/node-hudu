/**
 * Error hierarchy + errorFromStatus tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../src/client.js';
import { stubFetch, json, clearFetch } from './helpers.js';
import {
  HuduError, HuduConfigError, HuduNetworkError, BadRequestError, UnauthorizedError,
  ForbiddenError, NotFoundError, MethodNotAllowedError, NotAcceptableError,
  UnprocessableEntityError, RateLimitError, ServerError, errorFromStatus, isHuduError,
  ValidationFailedError, parseFieldErrors, UNKNOWN_FIELD, HuduContentLossError,
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

describe('parseFieldErrors / fieldErrors (normalized field-level validation)', () => {
  it('reads the Rails map form (field -> string[])', () => {
    const body = { errors: { name: ["can't be blank"], address: ['is invalid'] } };
    expect(parseFieldErrors(body)).toEqual([
      { field: 'name', message: "can't be blank" },
      { field: 'address', message: 'is invalid' },
    ]);
  });
  it('reads the Rails map form (field -> string) and keeps one entry per message', () => {
    expect(parseFieldErrors({ errors: { name: 'is invalid', zip: ['too short', 'not numeric'] } })).toEqual([
      { field: 'name', message: 'is invalid' },
      { field: 'zip', message: 'too short' },
      { field: 'zip', message: 'not numeric' },
    ]);
  });
  it('skips unusable map values instead of inventing a field', () => {
    expect(parseFieldErrors({ errors: { name: '   ', other: [7, null, 'real'] } })).toEqual([
      { field: 'other', message: 'real' },
    ]);
  });
  it('falls through an empty/unusable map to the prose shape', () => {
    expect(parseFieldErrors({ errors: { name: [] }, details: 'param is missing or the value is empty: company' })).toEqual([
      { field: 'company', message: 'param is missing or the value is empty: company' },
    ]);
  });
  it('reads a top-level errors STRING with the UNKNOWN_FIELD sentinel', () => {
    const body = { errors: 'Network does not belong to the specified company' };
    expect(parseFieldErrors(body)).toEqual([
      { field: UNKNOWN_FIELD, message: 'Network does not belong to the specified company' },
    ]);
    expect(UNKNOWN_FIELD).toBe('*');
  });
  it('reads a top-level errors ARRAY of strings with the sentinel', () => {
    expect(parseFieldErrors({ errors: ['is invalid', ' ', 42] })).toEqual([
      { field: UNKNOWN_FIELD, message: 'is invalid' },
    ]);
  });
  it('reads the `details` prose form and takes the field after the last ": "', () => {
    expect(parseFieldErrors({ error: 'Parameter missing', details: 'param is missing or the value is empty: company' })).toEqual([
      { field: 'company', message: 'param is missing or the value is empty: company' },
    ]);
  });
  it('accepts dotted/bracketed field names in prose', () => {
    expect(parseFieldErrors({ details: 'is invalid: addresses[0][street]' })).toEqual([
      { field: 'addresses[0][street]', message: 'is invalid: addresses[0][street]' },
    ]);
  });
  it('uses the sentinel when the prose tail is not a field name', () => {
    expect(parseFieldErrors({ details: 'Network does not belong to the specified company' })).toEqual([
      { field: UNKNOWN_FIELD, message: 'Network does not belong to the specified company' },
    ]);
    expect(parseFieldErrors({ details: 'bad: it is broken' })).toEqual([
      { field: UNKNOWN_FIELD, message: 'bad: it is broken' },
    ]);
    expect(parseFieldErrors({ details: `bad: ${'x'.repeat(65)}` })).toEqual([
      { field: UNKNOWN_FIELD, message: `bad: ${'x'.repeat(65)}` },
    ]);
    expect(parseFieldErrors({ details: 'ends with colon: ' })).toEqual([
      { field: UNKNOWN_FIELD, message: 'ends with colon:' },
    ]);
  });
  it('prefers the errors map over a string errors field and over details', () => {
    expect(parseFieldErrors({ errors: { name: 'blank' }, details: 'param is empty: company' })).toEqual([
      { field: 'name', message: 'blank' },
    ]);
  });
  it('returns undefined for bodies with no field detail', () => {
    for (const body of ['boom', 42, null, undefined, true, [], { message: 'explained' }, {}, { details: 7 }]) {
      expect(parseFieldErrors(body)).toBeUndefined();
    }
  });
  it('never throws on a circular body (and still parses it)', () => {
    const circular: Record<string, unknown> = { errors: { name: ["can't be blank"] } };
    circular.self = circular;
    expect(parseFieldErrors(circular)).toEqual([{ field: 'name', message: "can't be blank" }]);
    const evil: Record<string, unknown> = {};
    evil.errors = evil;
    expect(parseFieldErrors(evil)).toBeUndefined();
  });
  it('never throws when reading the body itself fails (a hostile getter)', () => {
    const hostile = {
      get errors(): unknown {
        throw new Error('getter blew up');
      },
    };
    expect(parseFieldErrors(hostile)).toBeUndefined();
  });
  it('populates fieldErrors on a 422 without touching the rest of the contract', () => {
    const body = { errors: 'Network does not belong to the specified company' };
    const e = errorFromStatus(422, body, 'https://x/api/v1/networks');
    expect(e).toBeInstanceOf(UnprocessableEntityError);
    expect(e.code).toBe('UNPROCESSABLE_ENTITY');
    expect(e.status).toBe(422);
    expect(e.message).toBe('Unprocessable Entity');
    expect(e.body).toBe(body);
    expect(e.vendorError).toBe(body);
    expect(e.fieldErrors).toEqual([
      { field: UNKNOWN_FIELD, message: 'Network does not belong to the specified company' },
    ]);
  });
  it('populates fieldErrors on a 400 details body', () => {
    const e = errorFromStatus(400, { error: 'Parameter missing', details: 'param is missing or the value is empty: company' });
    expect(e).toBeInstanceOf(BadRequestError);
    expect(e.message).toBe('Parameter missing');
    expect(e.fieldErrors).toEqual([
      { field: 'company', message: 'param is missing or the value is empty: company' },
    ]);
  });
  it('populates fieldErrors on a ValidationFailedError and lets the caller override them', () => {
    const e = new ValidationFailedError('bad', 'u', { errors: { name: 'blank' } });
    expect(e.fieldErrors).toEqual([{ field: 'name', message: 'blank' }]);
    const forced = new ValidationFailedError('bad', 'u', { errors: { name: 'blank' } }, { fieldErrors: [] });
    expect(forced.fieldErrors).toEqual([]);
  });
  it('leaves fieldErrors undefined on non-validation errors', () => {
    expect(errorFromStatus(404, { errors: { name: 'blank' } }).fieldErrors).toBeUndefined();
    expect(errorFromStatus(500, { errors: 'boom' }).fieldErrors).toBeUndefined();
    expect(new HuduError('x', { body: { errors: 'boom' } }).fieldErrors).toBeUndefined();
    expect(new HuduNetworkError('down').fieldErrors).toBeUndefined();
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

describe('fieldErrors end-to-end through the transport (live body shapes, stubbed)', () => {
  afterEach(clearFetch);
  const client = () => new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });

  it('422 {"errors":"Network does not belong to the specified company"}', async () => {
    stubFetch(() => json({ errors: 'Network does not belong to the specified company' }, 422));
    const err = await client().companies.create({ name: 'Acme' }).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as UnprocessableEntityError,
    );
    expect(err.code).toBe('UNPROCESSABLE_ENTITY');
    expect(err.status).toBe(422);
    expect(err.message).toBe('Unprocessable Entity');
    expect(err.body).toEqual({ errors: 'Network does not belong to the specified company' });
    expect(err.fieldErrors).toEqual([
      { field: UNKNOWN_FIELD, message: 'Network does not belong to the specified company' },
    ]);
  });

  it('400 {"error":"Parameter missing","details":"...: company"}', async () => {
    const body = { error: 'Parameter missing', details: 'param is missing or the value is empty: company' };
    stubFetch(() => json(body, 400));
    const err = await client().companies.create({ name: 'Acme' }).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as BadRequestError,
    );
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('Parameter missing');
    expect(err.vendorError).toEqual(body);
    expect(err.fieldErrors).toEqual([
      { field: 'company', message: 'param is missing or the value is empty: company' },
    ]);
  });
});

describe('HuduContentLossError', () => {
  const finding = {
    code: 'ROUNDTRIP_CALLOUT_FLATTENED' as const,
    severity: 'error' as const,
    impact: 'content' as const,
    element: 'callout' as const,
    message: 'Callout count changed across the round trip (1 -> 0).',
  };

  it('carries the findings and names both ways forward', () => {
    const err = new HuduContentLossError('articles.update', [finding]);
    expect(err).toBeInstanceOf(HuduError);
    expect(err.code).toBe('CONTENT_LOSS');
    expect(err.findings).toEqual([finding]);
    expect(err.message).toContain('ROUNDTRIP_CALLOUT_FLATTENED');
    expect(err.message).toContain('allowLossyMarkdown');
    expect(err.message).toContain('HTML');
  });

  it('names every content-impact finding, not just the first', () => {
    const second = { ...finding, code: 'ROUNDTRIP_TASK_STATE_LOST' as const, element: 'taskList' as const };
    const err = new HuduContentLossError('articles.update', [finding, second]);
    expect(err.message).toContain('ROUNDTRIP_CALLOUT_FLATTENED');
    expect(err.message).toContain('ROUNDTRIP_TASK_STATE_LOST');
  });
});

import type { FastifyReply } from 'fastify';
import type { ApiError } from '../../../shared/api.ts';

export function apiError(error: string, message: string): ApiError {
  return { error, message };
}

/** Sends a JSON ApiError and returns the reply (so async hooks can `return sendError(...)`). */
export function sendError(reply: FastifyReply, status: number, error: string, message: string): FastifyReply {
  return reply.code(status).type('application/json; charset=utf-8').send(apiError(error, message));
}

/** Path part of a request URL without the query string. */
export function urlPath(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

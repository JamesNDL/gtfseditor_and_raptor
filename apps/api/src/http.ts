// Small helpers every route file uses: an error that carries its HTTP status, and number parsers.

/** An error Fastify sends with this status code and message. */
export const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

/** A whole number of 0 or more from a URL parameter or query, or a 400. */
export const int = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw Object.assign(new Error('Expected a whole number'), { statusCode: 400 });
  return n;
};

export const notFound = (what: string) =>
  Object.assign(new Error(`${what} not found`), { statusCode: 404 });

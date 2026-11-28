const transientStatuses = new Set([408, 500, 502, 503, 504]);

export function isTransientResourceError(error) {
  return error instanceof TypeError || error?.name === 'NetworkError' || transientStatuses.has(error?.status);
}

export function resourceResponseError(response, message) {
  response.body?.cancel().catch(() => {});
  return Object.assign(new Error(message), {status:response.status});
}

export async function retryResource(read, signal) {
  signal?.throwIfAborted();
  try {
    return await read(false);
  } catch (error) {
    signal?.throwIfAborted();
    if (!isTransientResourceError(error)) throw error;
    return read(true);
  }
}

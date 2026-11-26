/**
 * Periodically registers this Battle Worker with the Go Control Plane and pushes
 * live room / draining / tick latency heartbeats.
 */
export function startControlPlaneReporter({
  controlPlaneUrl,
  authToken,
  workerId,
  wsUrlProvider,
  maps,
  maxRooms,
  region = process.env.DUST2_REGION || '',
  intervalMs = 3000,
  getState,
  onError = () => {},
}) {
  if (!controlPlaneUrl) return null;
  const base = controlPlaneUrl.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };

  let registered = false;
  let stopped = false;
  let inFlight = null;
  let pendingReport = false;

  async function postJSON(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
    return response;
  }

  async function register() {
    const wsUrl = typeof wsUrlProvider === 'function' ? wsUrlProvider() : wsUrlProvider;
    const res = await postJSON('/api/v1/workers/register', {
      workerId,
      wsUrl,
      maps,
      maxRooms,
      region,
    });
    if (!res.ok) {
      throw new Error(`Worker register failed: ${res.status}`);
    }
    registered = true;
  }

  async function pushOnce() {
    if (stopped) return;
    try {
      if (!registered) {
        await register();
      }
      const state = getState();
      const res = await postJSON('/api/v1/workers/heartbeat', {
        workerId,
        draining: state.draining,
        tickP99Ms: state.tickP99Ms,
        rooms: state.rooms,
      });
      if (res.status === 404) {
        registered = false;
        await register();
        await postJSON('/api/v1/workers/heartbeat', {
          workerId,
          draining: state.draining,
          tickP99Ms: state.tickP99Ms,
          rooms: state.rooms,
        });
      } else if (!res.ok) {
        throw new Error(`Worker heartbeat failed: ${res.status}`);
      }
    } catch (error) {
      onError(error);
    }
  }

  async function runLoop() {
    do {
      pendingReport = false;
      await pushOnce();
    } while (pendingReport && !stopped);
  }

  function reportNow() {
    if (stopped) return Promise.resolve();
    pendingReport = true;
    if (!inFlight) {
      inFlight = runLoop().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  const timer = setInterval(() => {
    void reportNow();
  }, Math.max(500, intervalMs));
  timer.unref();

  const initialPromise = reportNow();

  return {
    ready: initialPromise,
    reportNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight.catch(() => {});
    },
  };
}
